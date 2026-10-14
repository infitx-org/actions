"""Check workflow files against the keys GitHub Actions accepts, not just YAML.

`yaml.safe_load` accepts a job-level key like `audit:` that Actions rejects with
"Unexpected value 'audit'", so a mis-indented line passes every check that only
parses the file and fails the whole workflow for every repository that calls it —
including the ones that do not own the file.

    python3 check-workflows.py .github/workflows/*.yaml

Exits non-zero and prints `file:line: message` for anything it rejects.
"""
import sys

import yaml

# https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions
WORKFLOW_KEYS = {
    'name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs',
}
JOB_KEYS = {
    'name', 'runs-on', 'needs', 'if', 'permissions', 'environment', 'concurrency',
    'outputs', 'env', 'defaults', 'steps', 'timeout-minutes', 'continue-on-error',
    'container', 'services', 'strategy', 'uses', 'with', 'secrets',
}
STEP_KEYS = {
    'name', 'id', 'if', 'uses', 'run', 'with', 'env', 'shell', 'working-directory',
    'continue-on-error', 'timeout-minutes',
}
# Keys whose value must be a mapping of name -> expression string.
EXPRESSION_MAPS = {'outputs'}


def check(path):
    with open(path) as handle:
        document = yaml.safe_load(handle)
    problems = []

    def walk(node, trail, allowed):
        if not isinstance(node, dict):
            problems.append(f'{trail}: expected a mapping, found {type(node).__name__}')
            return
        for key, value in node.items():
            # PyYAML resolves the bare `on:` key of a workflow to the boolean True.
            key = 'on' if key is True else key
            if key not in allowed:
                problems.append(f'{trail}.{key}: not a key Actions accepts here')
            if key in EXPRESSION_MAPS and isinstance(value, dict):
                for name, expression in value.items():
                    text = str(expression)
                    if not text.startswith('${{'):
                        problems.append(
                            f'{trail}.{key}.{name}: {text!r} is not a `${{{{ ... }}}}` expression')

    walk(document, path, WORKFLOW_KEYS)
    for job_id, job in (document.get('jobs') or {}).items():
        walk(job, f'{path}:{job_id}', JOB_KEYS)
        for index, step in enumerate(job.get('steps') or []):
            walk(step, f'{path}:{job_id}.steps[{index}]', STEP_KEYS)
            if isinstance(step, dict):
                has_uses, has_run = 'uses' in step, 'run' in step
                if has_uses == has_run:
                    problems.append(
                        f'{path}:{job_id}.steps[{index}]: needs exactly one of `uses` or `run`')

    # A job that returns an output nobody declared is a typo rather than a feature.
    for job_id, job in (document.get('jobs') or {}).items():
        for need in [job.get('needs')] if isinstance(job.get('needs'), str) else (job.get('needs') or []):
            target = (document['jobs']).get(need)
            if target is None:
                problems.append(f'{path}:{job_id}.needs: no such job `{need}`')
                continue
            for reference in set(_references(job)):
                if reference.startswith(f'needs.{need}.'):
                    output = reference.split('.')[3]
                    if output not in (target.get('outputs') or {}):
                        problems.append(
                            f'{path}:{job_id}: reads `needs.{need}.{output}` '
                            f'but `{need}` does not declare it')
    return problems


def _references(node):
    """Every `${{ needs.<job>.<output> }}` string anywhere under `node`.

    `needs.<job>.result` is an Actions property rather than a declared output, so it
    is left out; anything else is not a reference to a job output at all.
    """
    found = []
    if isinstance(node, str) and 'needs.' in node:
        for piece in node.replace('${{', ' ').replace('}}', ' ').split():
            piece = piece.strip('(),;\'"!=')
            parts = piece.split('.')
            if len(parts) == 4 and parts[0] == 'needs' and parts[2] == 'outputs':
                found.append(piece)
    elif isinstance(node, dict):
        for value in node.values():
            found.extend(_references(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(_references(value))
    return found


if __name__ == '__main__':
    failed = False
    for argument in sys.argv[1:]:
        for problem in check(argument):
            print(problem)
            failed = True
    if failed:
        sys.exit(1)
    print(f'{len(sys.argv) - 1} workflow file(s) accepted')
