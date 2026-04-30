import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_install_launchd_script_writes_valid_plist(tmp_path):
    output_dir = tmp_path / 'LaunchAgents'
    runtime_home = tmp_path / 'runtime'
    script = REPO_ROOT / 'openclaw' / 'install' / 'install-launchd.sh'
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(runtime_home)
    subprocess.run(
        [str(script), '--write-only', '--output-dir', str(output_dir), '--interval', '1800'],
        check=True,
        env=env,
    )
    plists = list(output_dir.glob('*.plist'))
    assert len(plists) == 1
    contents = plists[0].read_text()
    assert 'run_scheduler.py' in contents
    assert '1800' in contents
