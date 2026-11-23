import os
import subprocess
import sys


def test_admin_and_user_portals_in_a_fresh_database():
    here = os.path.dirname(os.path.abspath(__file__))
    env = {k: v for k, v in os.environ.items() if k not in ("TEST_DATABASE_URL", "ALLOW_ORG_SIGNUP", "DATABASE_URL")}
    r = subprocess.run([sys.executable, os.path.join(here, "portal_scenario.py")], capture_output=True, text=True, env=env, timeout=240)
    print(r.stdout)
    assert r.returncode == 0 and "ALL PASSED" in r.stdout, r.stdout[-1500:] + r.stderr[-1500:]
