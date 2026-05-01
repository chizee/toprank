import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_all_schema_files_are_valid_json():
    schema_dir = REPO_ROOT / 'openclaw' / 'artifacts' / 'schemas'
    for path in schema_dir.glob('*.json'):
        data = json.loads(path.read_text())
        assert data['type'] == 'object'
        assert '$schema' in data


def test_example_action_plan_has_expected_shape():
    path = REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'action-plan.json'
    data = json.loads(path.read_text())
    assert data['site_id'] == 'example.com'
    assert data['actions']
    assert data['actions'][0]['requires_approval'] is True


def test_bootstrap_workspace_and_site(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_workspace.py')], check=True, env=env)
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'https://Example.com'], check=True, env=env)
    site_root = tmp_path / 'runtime' / 'sites' / 'example.com'
    assert (tmp_path / 'runtime' / 'portfolio.json').exists()
    assert (site_root / 'site-profile.json').exists()
    assert (site_root / 'queue').is_dir()
    profile = json.loads((site_root / 'site-profile.json').read_text())
    assert profile['site_id'] == 'example.com'


def test_onboard_site_updates_portfolio_and_goal(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'onboard_site.py'),
            'https://example.com',
            '--display-name',
            'Example Site',
            '--brand-terms',
            'Example,Example Site',
            '--business-weight',
            '0.8',
            '--cadence',
            'weekly',
            '--goal-type',
            'grow_non_brand_clicks',
            '--primary-metric',
            'non_brand_clicks_28d',
        ],
        check=True,
        env=env,
    )
    portfolio = json.loads((tmp_path / 'runtime' / 'portfolio.json').read_text())
    assert portfolio['sites'][0]['site_id'] == 'example.com'
    assert portfolio['sites'][0]['business_weight'] == 0.8
    site_root = tmp_path / 'runtime' / 'sites' / 'example.com'
    profile = json.loads((site_root / 'site-profile.json').read_text())
    assert profile['display_name'] == 'Example Site'
    assert profile['brand_terms'] == ['Example', 'Example Site']
    goals = json.loads((site_root / 'goals.json').read_text())
    assert goals['active']
    assert goals['active'][0]['primary_metric'] == 'non_brand_clicks_28d'


def test_persist_run_writes_artifacts_and_queue(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    payload_path = tmp_path / 'payload.json'
    payload_path.write_text((REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'weekly-review-payload.json').read_text())
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'persist_run.py'),
            'example.com',
            '--payload-file',
            str(payload_path),
        ],
        check=True,
        env=env,
    )
    runs_dir = tmp_path / 'runtime' / 'sites' / 'example.com' / 'runs'
    run_dirs = [path for path in runs_dir.iterdir() if path.is_dir()]
    assert len(run_dirs) == 1
    run_dir = run_dirs[0]
    assert (run_dir / 'audit.json').exists()
    assert (run_dir / 'action-plan.json').exists()
    assert (run_dir / 'verification.json').exists()
    latest = json.loads((tmp_path / 'runtime' / 'sites' / 'example.com' / 'latest-state.json').read_text())
    assert 'Homepage CTR' in latest['summary']
    queue_dir = tmp_path / 'runtime' / 'sites' / 'example.com' / 'queue'
    queue_files = list(queue_dir.glob('*.json'))
    assert len(queue_files) == 1
    queue_item = json.loads(queue_files[0].read_text())
    assert queue_item['type'] == 'feedback_check'
    assert queue_item['baseline_metrics']['organic_clicks_28d'] == 100
    assert queue_item['primary_metric'] == 'non_brand_clicks_28d'
    assert queue_item['action_type'] == 'meta_tags'
    schedule = json.loads((tmp_path / 'runtime' / 'schedule.json').read_text())
    assert schedule['upcoming']
    assert schedule['upcoming'][0]['item_id'] == queue_item['item_id']


def test_improve_page_persists_proposal_and_patch_set(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'improve_page.py'),
            'example.com',
            '--url',
            'https://example.com/services/roof-repair',
            '--issue-summary',
            'Service page CTR is low and schema is missing.',
            '--proposal-summary',
            'Draft new title/meta candidates and add LocalBusiness schema.',
            '--patch-path',
            'pages/services/roof-repair.tsx',
            '--patch-summary',
            'Add schema and update metadata fields.',
        ],
        check=True,
        env=env,
    )
    run_dirs = list((tmp_path / 'runtime' / 'sites' / 'example.com' / 'runs').iterdir())
    assert len(run_dirs) == 1
    run_dir = run_dirs[0]
    assert (run_dir / 'proposal.json').exists()
    assert (run_dir / 'patch-set.json').exists()
    proposal = json.loads((run_dir / 'proposal.json').read_text())
    assert proposal['target'] == 'https://example.com/services/roof-repair'
    patch_set = json.loads((run_dir / 'patch-set.json').read_text())
    assert patch_set['patches'][0]['path'] == 'pages/services/roof-repair.tsx'


def test_investigate_drop_creates_recovery_plan_and_followups(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'investigate_drop.py'),
            'example.com',
            '--summary',
            'Organic clicks fell sharply on the primary service cluster.',
            '--likely-cause',
            'A service page may have fallen out of the index.',
            '--likely-cause',
            'Homepage CTR declined after a copy update.',
            '--target-url',
            'https://example.com/services/roof-repair',
        ],
        check=True,
        env=env,
    )
    run_dirs = list((tmp_path / 'runtime' / 'sites' / 'example.com' / 'runs').iterdir())
    assert len(run_dirs) == 1
    run_dir = run_dirs[0]
    audit = json.loads((run_dir / 'audit.json').read_text())
    assert len(audit['issues']) == 2
    queue_files = list((tmp_path / 'runtime' / 'sites' / 'example.com' / 'queue').glob('*.json'))
    queue_types = {json.loads(path.read_text())['type'] for path in queue_files}
    assert 'feedback_check' in queue_types
    assert 'improve_page' in queue_types


def test_followups_due_lists_due_items(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    payload_path = tmp_path / 'payload.json'
    payload = json.loads((REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'weekly-review-payload.json').read_text())
    payload['queue_items'][0]['due_at'] = '2026-04-01T00:00:00Z'
    payload_path.write_text(json.dumps(payload, indent=2) + '\n')
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'persist_run.py'),
            'example.com',
            '--payload-file',
            str(payload_path),
        ],
        check=True,
        env=env,
    )
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'followups_due.py'),
            '--as-of',
            '2026-04-15T00:00:00Z',
        ],
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    assert data['count'] == 1
    assert data['items'][0]['type'] == 'feedback_check'


def test_hydrate_followup_gsc_updates_observed_metrics(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    payload_path = tmp_path / 'payload.json'
    payload = json.loads((REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'weekly-review-payload.json').read_text())
    payload_path.write_text(json.dumps(payload, indent=2) + '\n')
    subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'persist_run.py'), 'example.com', '--payload-file', str(payload_path)],
        check=True,
        env=env,
    )
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'hydrate_followup_gsc.py'),
            'example.com',
            'followup_example_homepage_ctr_14d',
            '--analysis-file',
            str(REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'gsc-analysis-sample.json'),
        ],
        check=True,
        env=env,
    )
    queue_path = tmp_path / 'runtime' / 'sites' / 'example.com' / 'queue' / 'followup_example_homepage_ctr_14d.json'
    queue_item = json.loads(queue_path.read_text())
    assert queue_item['observed_metrics']['non_brand_clicks_28d'] == 110.0
    assert queue_item['observed_metrics']['organic_clicks_28d'] == 150.0


def test_record_followup_metrics_and_score_script(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    payload_path = tmp_path / 'payload.json'
    payload = json.loads((REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'weekly-review-payload.json').read_text())
    payload['queue_items'][0]['due_at'] = '2026-04-01T00:00:00Z'
    payload['queue_items'][0]['baseline_metrics'] = {'organic_clicks_28d': 100, 'conversions_28d': 10}
    payload['queue_items'][0]['primary_metric'] = 'organic_clicks_28d'
    payload['queue_items'][0]['success_threshold_pct'] = 0.1
    payload['queue_items'][0]['guardrail_metrics'] = [{'metric': 'conversions_28d', 'direction': 'higher_better', 'max_worsen_pct': 0.05}]
    payload_path.write_text(json.dumps(payload, indent=2) + '\n')
    subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'persist_run.py'), 'example.com', '--payload-file', str(payload_path)],
        check=True,
        env=env,
    )
    item_id = payload['queue_items'][0]['item_id']
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'record_followup_metrics.py'),
            'example.com',
            item_id,
            '--observed-metric',
            'organic_clicks_28d=125',
            '--observed-metric',
            'conversions_28d=11',
        ],
        check=True,
        env=env,
    )
    queue_path = tmp_path / 'runtime' / 'sites' / 'example.com' / 'queue' / f'{item_id}.json'
    score_result = subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'score_feedback.py'), '--item-file', str(queue_path)],
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )
    score = json.loads(score_result.stdout)
    assert score['outcome'] == 'win'
    assert score['primary_metric'] == 'organic_clicks_28d'


def test_run_scheduler_processes_due_feedback_checks(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    payload_path = tmp_path / 'payload.json'
    payload = json.loads((REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'weekly-review-payload.json').read_text())
    payload['queue_items'][0]['due_at'] = '2026-04-01T00:00:00Z'
    payload['queue_items'][0]['baseline_metrics'] = {'organic_clicks_28d': 100}
    payload['queue_items'][0]['observed_metrics'] = {'organic_clicks_28d': 120}
    payload['queue_items'][0]['primary_metric'] = 'organic_clicks_28d'
    payload['queue_items'][0]['success_threshold_pct'] = 0.1
    payload_path.write_text(json.dumps(payload, indent=2) + '\n')
    subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'persist_run.py'), 'example.com', '--payload-file', str(payload_path)],
        check=True,
        env=env,
    )
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'run_scheduler.py'), '--as-of', '2026-04-15T00:00:00Z'],
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    assert len(data['processed']) == 1
    schedule = json.loads((tmp_path / 'runtime' / 'schedule.json').read_text())
    assert schedule['upcoming'][0]['status'] == 'processed'
    feedback_dir = tmp_path / 'runtime' / 'sites' / 'example.com' / 'feedback'
    feedback_files = list(feedback_dir.glob('*.json'))
    assert len(feedback_files) == 1
    feedback = json.loads(feedback_files[0].read_text())
    assert feedback['status'] == 'win'
    learned = json.loads((tmp_path / 'runtime' / 'sites' / 'example.com' / 'learned-patterns.json').read_text())
    assert learned['priors']['meta_tags::organic_clicks_28d']['wins'] == 1


def test_run_scheduler_surfaces_manual_attention_items(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run([sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'bootstrap_site.py'), 'example.com'], check=True, env=env)
    schedule_path = tmp_path / 'runtime' / 'schedule.json'
    schedule = {'schema_version': '1', 'upcoming': [{'item_id': 'manual_001', 'site_id': 'example.com', 'type': 'improve_page', 'status': 'pending', 'due_at': '2026-04-01T00:00:00Z'}]}
    schedule_path.write_text(json.dumps(schedule, indent=2) + '\n')
    queue_path = tmp_path / 'runtime' / 'sites' / 'example.com' / 'queue' / 'manual_001.json'
    queue_path.write_text(json.dumps(schedule['upcoming'][0], indent=2) + '\n')
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'run_scheduler.py'), '--as-of', '2026-04-15T00:00:00Z'],
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    assert len(data['manual_attention']) == 1
    updated_schedule = json.loads(schedule_path.read_text())
    assert updated_schedule['upcoming'][0]['status'] == 'ready_for_attention'


def test_weekly_review_uses_learned_priors_and_seeds_followup(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'onboard_site.py'),
            'https://example.com',
            '--display-name',
            'Example',
            '--goal-type',
            'grow_non_brand_clicks',
            '--primary-metric',
            'non_brand_clicks_28d',
        ],
        check=True,
        env=env,
    )
    learned_path = tmp_path / 'runtime' / 'sites' / 'example.com' / 'learned-patterns.json'
    learned_path.write_text(json.dumps({
        'site_id': 'example.com',
        'observations': [],
        'priors': {
            'meta_tags::non_brand_clicks_28d': {
                'action_type': 'meta_tags',
                'primary_metric': 'non_brand_clicks_28d',
                'sample_size': 3,
                'wins': 2,
                'neutral': 1,
                'losses': 0,
                'inconclusive': 0,
                'avg_primary_change': 0.18,
                'confidence': 0.72,
                'last_outcome': 'win',
                'last_updated_at': '2026-04-01T00:00:00Z'
            },
            'page_improvement::non_brand_clicks_28d': {
                'action_type': 'page_improvement',
                'primary_metric': 'non_brand_clicks_28d',
                'sample_size': 2,
                'wins': 0,
                'neutral': 0,
                'losses': 2,
                'inconclusive': 0,
                'avg_primary_change': -0.15,
                'confidence': 0.8,
                'last_outcome': 'loss',
                'last_updated_at': '2026-04-01T00:00:00Z'
            }
        }
    }, indent=2) + '\n')
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'weekly_review.py'),
            'example.com',
            '--analysis-file',
            str(REPO_ROOT / 'openclaw' / 'artifacts' / 'examples' / 'gsc-analysis-sample.json'),
        ],
        check=True,
        env=env,
    )
    run_dirs = sorted((tmp_path / 'runtime' / 'sites' / 'example.com' / 'runs').iterdir())
    run_dir = run_dirs[-1]
    action_plan = json.loads((run_dir / 'action-plan.json').read_text())
    assert action_plan['actions'][0]['type'] == 'snippet_content_packaging'
    queue_files = list((tmp_path / 'runtime' / 'sites' / 'example.com' / 'queue').glob('*.json'))
    queue_items = [json.loads(path.read_text()) for path in queue_files]
    queue_by_type = {item['type']: item for item in queue_items}
    assert set(queue_by_type) == {'business_context_request', 'action_proposal'}
    assert queue_by_type['business_context_request']['status'] == 'pending_input'
    assert queue_by_type['business_context_request']['business_context_questions']
    queue_item = queue_by_type['action_proposal']
    assert queue_item['baseline_metrics']['non_brand_clicks_28d'] == 110.0
    assert queue_item['primary_metric'] == 'non_brand_clicks_28d'
    assert queue_item['action_type'] == 'snippet_content_packaging'
    assert 'complete_business_context' in queue_item['approval_preconditions']


def test_portfolio_review_ranks_sites(tmp_path):
    env = os.environ.copy()
    env['TOPRANK_OPENCLAW_HOME'] = str(tmp_path / 'runtime')
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'onboard_site.py'),
            'https://alpha.example',
            '--display-name',
            'Alpha',
            '--business-weight',
            '1.0',
        ],
        check=True,
        env=env,
    )
    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / 'openclaw' / 'bin' / 'onboard_site.py'),
            'https://beta.example',
            '--display-name',
            'Beta',
            '--business-weight',
            '0.5',
        ],
        check=True,
        env=env,
    )
    latest_alpha = tmp_path / 'runtime' / 'sites' / 'alpha.example' / 'latest-state.json'
    latest_beta = tmp_path / 'runtime' / 'sites' / 'beta.example' / 'latest-state.json'
    latest_alpha.write_text(json.dumps({
        'site_id': 'alpha.example',
        'summary': 'Alpha has a critical indexing regression.',
        'open_issues': [{'title': 'Critical indexing regression', 'severity': 'critical'}],
        'recent_actions': []
    }, indent=2) + '\n')
    latest_beta.write_text(json.dumps({
        'site_id': 'beta.example',
        'summary': 'Beta is stable.',
        'open_issues': [],
        'recent_actions': []
    }, indent=2) + '\n')
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / 'openclaw' / 'bin' / 'portfolio_review.py')],
        check=True,
        env=env,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    assert data['recommended_focus_site'] == 'alpha.example'
    review_dir = tmp_path / 'runtime' / 'portfolio-reviews'
    assert any(review_dir.glob('*.json'))
