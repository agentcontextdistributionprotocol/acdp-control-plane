#!/usr/bin/env python3
"""Offline tests for deploy/doppler-sync.sh: it must fail closed and keep secrets off argv and output.

Runs the real script against fake `curl`, `doppler` and `railway` binaries (and an argv-logging `jq` shim
around the real jq) in a throwaway git repo. Nothing touches the network, Doppler or Railway.

Every failure mode (a GraphQL `errors` array with HTTP 200, `{"data": null}`, a non-2xx answer, a network
error, an unparsable body, a failing or garbage Doppler read) must exit non-zero, report no key as new or
changed, and send no mutation, in dry-run and --apply mode alike. Sentinel token and secret values must never
appear in any argv or in the script's output.

    python3 deploy/test_doppler_sync.py            # tests the script next to this file
    DOPPLER_SYNC=/path/to/old.sh python3 deploy/test_doppler_sync.py   # run the same tests against another copy
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = Path(os.environ.get("DOPPLER_SYNC", HERE / "doppler-sync.sh")).resolve()
KEYS_FILE = HERE / "doppler-keys.txt"

TOKEN = "SENTINEL-RAILWAY-TOKEN-7f3a91c2"
SECRET = "SENTINEL-SECRET-VALUE-b84e02d6"
NEW_SECRET = "SENTINEL-NEW-SECRET-VALUE-19cd55aa"

FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, sys
state = os.environ["FAKE_STATE"]
argv = sys.argv[1:]
with open(os.path.join(state, "argv.log"), "a") as f:
    f.write(json.dumps(["curl"] + argv) + "\n")

flags, headers, i = "", [], 0
while i < len(argv):
    a = argv[i]
    if a == "-H":
        h = argv[i + 1]
        if h.startswith("@"):
            with open(h[1:]) as hf:
                headers += [l.rstrip("\r\n") for l in hf if l.strip()]
        else:
            headers.append(h)
        i += 2
        continue
    if a.startswith("-") and not a.startswith("--"):
        flags += a[1:]
    i += 1
fail_flag = "f" in flags or "--fail" in argv
body = sys.stdin.read()
req = json.loads(body) if body else {}
query = req.get("query", "")
with open(os.path.join(state, "requests.log"), "a") as f:
    f.write(json.dumps(req) + "\n")

kind = ("project" if "project(id" in query else "variables" if "variables(" in query
        else "upsert" if "variableUpsert" in query else "redeploy" if "serviceInstanceRedeploy" in query else "other")
if kind in ("upsert", "redeploy"):
    open(os.path.join(state, "mutations.log"), "a").write(kind + "\n")

mode = os.environ.get("FAKE_MODE", "ok")
fail_on = os.environ.get("FAKE_FAIL_ON", "any")
auth_ok = "Authorization: Bearer " + os.environ["EXPECT_TOKEN"] in headers

def respond(status, text):
    if status >= 400 and fail_flag:
        sys.stderr.write("curl: (22) The requested URL returned error: %d\n" % status)
        sys.exit(22)
    sys.stdout.write(text)
    sys.exit(0)

if mode != "ok" and fail_on in ("any", kind):
    if mode == "errors":
        respond(200, json.dumps({"data": None, "errors": [{"message": "Not Authorized"}]}))
    if mode == "data_null":
        respond(200, json.dumps({"data": None}))
    if mode == "no_data":
        respond(200, json.dumps({}))
    if mode == "http_500":
        respond(500, json.dumps({"errors": [{"message": "Internal"}]}))
    if mode == "http_401":
        respond(401, "Unauthorized")
    if mode == "network":
        sys.stderr.write("curl: (6) Could not resolve host: backboard.railway.com\n")
        sys.exit(6)
    if mode == "unparsable":
        respond(200, "<html>Bad Gateway</html>")
    if mode == "variables_null":
        respond(200, json.dumps({"data": {"variables": None}}))

if not auth_ok:
    # What Railway does for a missing or wrong token.
    respond(200, json.dumps({"data": None, "errors": [{"message": "Not Authorized"}]}))

railway = json.load(open(os.path.join(state, "railway.json")))
if kind == "project":
    respond(200, json.dumps({"data": {"project": {
        "environments": {"edges": [{"node": {"id": "env-1", "name": "production"}}]},
        "services": {"edges": [{"node": {"id": "svc-1", "name": os.environ["EXPECT_SERVICE"]}}]}}}}))
if kind == "variables":
    respond(200, json.dumps({"data": {"variables": railway}}))
if kind == "upsert":
    i = req["variables"]["i"]
    railway[i["name"]] = i["value"]
    json.dump(railway, open(os.path.join(state, "railway.json"), "w"))
    respond(200, json.dumps({"data": {"variableUpsert": True}}))
if kind == "redeploy":
    respond(200, json.dumps({"data": {"serviceInstanceRedeploy": True}}))
respond(400, json.dumps({"errors": [{"message": "unknown query"}]}))
'''

FAKE_DOPPLER = r'''#!/usr/bin/env python3
import json, os, sys
state = os.environ["FAKE_STATE"]
with open(os.path.join(state, "argv.log"), "a") as f:
    f.write(json.dumps(["doppler"] + sys.argv[1:]) + "\n")
mode = os.environ.get("FAKE_DOPPLER_MODE", "ok")
if mode == "fail":
    sys.stderr.write("Doppler Error: Unable to fetch secrets\n")
    sys.exit(1)
if mode == "garbage":
    sys.stdout.write("Doppler Error: you must be logged in\n")
    sys.exit(0)
if mode == "empty":
    sys.exit(0)
sys.stdout.write(open(os.path.join(state, "doppler.json")).read())
'''

FAKE_RAILWAY = r'''#!/bin/sh
printf '["railway"]\n' >> "$FAKE_STATE/argv.log"
echo "fake railway: the script must not call the railway CLI" >&2
exit 1
'''

JQ_SHIM = '''#!/bin/sh
python3 -c 'import json,sys; open(sys.argv[1],"a").write(json.dumps(["jq"]+sys.argv[2:])+"\\n")' "$FAKE_STATE/argv.log" "$@"
exec {real_jq} "$@"
'''


def managed_keys():
    keys = []
    for line in KEYS_FILE.read_text().splitlines():
        k = line.split("#", 1)[0].strip()
        if k:
            keys.append(k)
    return keys


class DopplerSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="doppler-sync-test-"))
        self.state = self.tmp / "state"
        self.state.mkdir()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.home = self.tmp / "home"
        self.home.mkdir()

        real_jq = shutil.which("jq")
        self.assertIsNotNone(real_jq, "jq is required")
        for name, body in (("curl", FAKE_CURL), ("doppler", FAKE_DOPPLER), ("railway", FAKE_RAILWAY),
                           ("jq", JQ_SHIM.format(real_jq=real_jq))):
            p = self.bin / name
            p.write_text(body)
            p.chmod(0o755)

        # A throwaway committed repo holding the script under test and the real allowlist.
        self.repo = self.tmp / "repo"
        (self.repo / "deploy").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / "deploy" / "doppler-sync.sh")
        shutil.copy(KEYS_FILE, self.repo / "deploy" / "doppler-keys.txt")
        git = ["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run(git[:3] + ["init", "-q"], check=True)
        subprocess.run(git[:3] + ["add", "."], check=True)
        subprocess.run(git + ["commit", "-qm", "fixture"], check=True)

        self.keys = managed_keys()
        self.assertTrue(self.keys)
        service = subprocess.run(["sed", "-n", "s/^RAILWAY_SERVICE=//p", str(SCRIPT)],
                                 capture_output=True, text=True, check=True).stdout.split()[0]
        self.env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(self.home),
            "FAKE_STATE": str(self.state),
            "EXPECT_TOKEN": TOKEN,
            "EXPECT_SERVICE": service,
            "RAILWAY_API_TOKEN": TOKEN,
            "LC_ALL": "C",
        }
        # In sync by default: every managed key holds a sentinel value on both sides.
        values = {k: f"{SECRET}-{i}" for i, k in enumerate(self.keys)}
        self.write_state(railway={**values, "UNMANAGED": "x"}, doppler=dict(values))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_state(self, railway, doppler):
        (self.state / "railway.json").write_text(json.dumps(railway))
        (self.state / "doppler.json").write_text(json.dumps(doppler))

    def run_sync(self, *args, **env):
        e = dict(self.env)
        e.update({k: v for k, v in env.items() if v is not None})
        for k, v in env.items():
            if v is None:
                e.pop(k, None)
        return subprocess.run(["bash", str(self.repo / "deploy" / "doppler-sync.sh"), *args],
                              env=e, capture_output=True, text=True, timeout=60)

    def log(self, name):
        p = self.state / name
        return p.read_text() if p.exists() else ""

    def assert_no_leak(self, res):
        out = res.stdout + res.stderr
        for sentinel in (TOKEN, SECRET, NEW_SECRET):
            self.assertNotIn(sentinel, out, f"{sentinel} leaked into output:\n{out}")
            self.assertNotIn(sentinel, self.log("argv.log"), f"{sentinel} leaked into an argv:\n{self.log('argv.log')}")

    def assert_failed_closed(self, res):
        out = res.stdout + res.stderr
        self.assertNotEqual(res.returncode, 0, f"expected a non-zero exit:\n{out}")
        self.assertNotRegex(out, r"\t(new|changed|unchanged)\b", f"reported key statuses despite the failure:\n{out}")
        self.assertNotIn("would change", out)
        self.assertNotIn("nothing to change", out)
        self.assertEqual(self.log("mutations.log"), "", "a mutation was sent despite the failure")
        self.assert_no_leak(res)

    # --- failure modes -------------------------------------------------------------------------------------

    FAILURES = [
        ("graphql errors with HTTP 200", {"FAKE_MODE": "errors"}),
        ("data null", {"FAKE_MODE": "data_null"}),
        ("data missing", {"FAKE_MODE": "no_data"}),
        ("non-2xx (500)", {"FAKE_MODE": "http_500"}),
        ("non-2xx (401)", {"FAKE_MODE": "http_401"}),
        ("network failure", {"FAKE_MODE": "network"}),
        ("unparsable body", {"FAKE_MODE": "unparsable"}),
        ("variables read: graphql errors", {"FAKE_MODE": "errors", "FAKE_FAIL_ON": "variables"}),
        ("variables read: data null", {"FAKE_MODE": "data_null", "FAKE_FAIL_ON": "variables"}),
        ("variables read: non-2xx", {"FAKE_MODE": "http_500", "FAKE_FAIL_ON": "variables"}),
        ("variables read: network failure", {"FAKE_MODE": "network", "FAKE_FAIL_ON": "variables"}),
        ("variables read: unparsable body", {"FAKE_MODE": "unparsable", "FAKE_FAIL_ON": "variables"}),
        ("variables read: variables null", {"FAKE_MODE": "variables_null", "FAKE_FAIL_ON": "variables"}),
        ("doppler read fails", {"FAKE_DOPPLER_MODE": "fail"}),
        ("doppler read is not JSON", {"FAKE_DOPPLER_MODE": "garbage"}),
        ("doppler read is empty", {"FAKE_DOPPLER_MODE": "empty"}),
        ("wrong railway token", {"RAILWAY_API_TOKEN": "SENTINEL-RAILWAY-TOKEN-7f3a91c2-but-wrong"}),
    ]

    def test_failure_modes_fail_closed(self):
        # Railway is empty, so a script that mistakes a failure for "no variables" would call every key new.
        for mode in ("--dry-run", "--apply"):
            for name, env in self.FAILURES:
                with self.subTest(mode=mode, failure=name):
                    for f in ("argv.log", "requests.log", "mutations.log"):
                        (self.state / f).unlink(missing_ok=True)
                    self.write_state(railway={}, doppler={k: f"{SECRET}-{k}" for k in self.keys})
                    res = self.run_sync(mode, **env)
                    self.assert_failed_closed(res)
                    self.assertEqual(json.loads((self.state / "railway.json").read_text()), {})

    def test_no_token_refuses(self):
        res = self.run_sync("--dry-run", RAILWAY_API_TOKEN=None)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("no Railway token", res.stderr)
        self.assertEqual(self.log("requests.log"), "", "made a request without a token")

    # --- happy paths (they also prove the fd header carries the token) --------------------------------------

    def test_dry_run_in_sync(self):
        res = self.run_sync()
        self.assertEqual(res.returncode, 0, res.stderr)
        for k in self.keys:
            self.assertRegex(res.stderr, rf"{k}\tunchanged")
        self.assertIn("(match)", res.stderr)
        self.assertIn("dry run: nothing to change", res.stderr)
        self.assertIn("left alone (not in doppler-keys.txt): UNMANAGED", res.stderr)
        self.assertEqual(self.log("mutations.log"), "")
        self.assert_no_leak(res)

    def test_dry_run_reports_change_without_writing(self):
        doppler = json.loads((self.state / "doppler.json").read_text())
        doppler[self.keys[0]] = NEW_SECRET
        (self.state / "doppler.json").write_text(json.dumps(doppler))
        res = self.run_sync("--dry-run")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertRegex(res.stderr, rf"{self.keys[0]}\tchanged")
        self.assertIn("1 key(s) would change", res.stderr)
        self.assertEqual(self.log("mutations.log"), "")
        self.assert_no_leak(res)

    def test_apply_sets_changed_key_by_stdin_and_redeploys(self):
        doppler = json.loads((self.state / "doppler.json").read_text())
        doppler[self.keys[0]] = NEW_SECRET
        (self.state / "doppler.json").write_text(json.dumps(doppler))
        res = self.run_sync("--apply")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.log("mutations.log").split(), ["upsert", "redeploy"])
        self.assertEqual(json.loads((self.state / "railway.json").read_text())[self.keys[0]], NEW_SECRET)
        self.assertIn("hash after apply", res.stderr)
        self.assertIn(NEW_SECRET, self.log("requests.log"), "the value should travel in the request body")
        self.assert_no_leak(res)

    def test_apply_in_sync_does_nothing(self):
        res = self.run_sync("--apply")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("apply: nothing to change; no redeploy", res.stderr)
        self.assertEqual(self.log("mutations.log"), "")
        self.assert_no_leak(res)

    def test_railway_reference_refused(self):
        railway = json.loads((self.state / "railway.json").read_text())
        railway[self.keys[0]] = "${{shared.X}}"
        (self.state / "railway.json").write_text(json.dumps(railway))
        res = self.run_sync("--apply")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("refusing", res.stderr)
        self.assertEqual(self.log("mutations.log"), "")
        self.assert_no_leak(res)


if __name__ == "__main__":
    print(f"testing {SCRIPT}", file=sys.stderr)
    unittest.main(verbosity=2)
