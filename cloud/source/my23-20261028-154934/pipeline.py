#!/usr/bin/env python3
"""One model; train=steps 1-6, apply=step 7, all=steps 1-7."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from common import HERE, STEPS, Context, get, identity, info, json_file, load_config, put, sha


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('mode', nargs='?', choices=['train', 'apply', 'all', 'step'], default='train')
    ap.add_argument('step', nargs='?', type=int, choices=range(1, 8))
    ap.add_argument('--config', type=Path)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    if args.mode == 'step' and args.step is None:
        ap.error('step requires a number, e.g. step 4')
    cfg = load_config(args.config)
    selected = [args.step] if args.mode == 'step' else ([7] if args.mode == 'apply' else list(range(1, 8 if args.mode == 'all' else 7)))
    if args.dry_run:
        print(json.dumps({'mode': args.mode, 'steps': [STEPS[i-1] for i in selected],
                          'output_root': cfg['output_root'], 'training_people': 2003,
                          'test_people': 501, 'markers': 'standard QC/LD only',
                          'cloud_reads_or_writes': False}, indent=2))
        return
    if 'run_id' not in cfg or 'staged_inputs' not in cfg:
        raise ValueError('Run bash deploy.sh first; the job needs its staged, frozen configuration')
    checked = set()
    for i in selected:
        ctx = Context(cfg, i)
        if ctx.completed():
            checked.add(i)
            continue
        for previous in range(1, i):
            if previous not in checked:
                ctx.require_step(previous)
                checked.add(previous)
        with tempfile.TemporaryDirectory() as d:
            snapshot = json_file({'run_id': cfg['run_id'], 'step': i,
                'config_sha256': ctx.signature, 'source_sha256': cfg['source_sha256'],
                'staged_inputs': cfg['staged_inputs'],
                'upstream_results': {STEPS[n-1]:ctx.result(n) for n in range(1,i)},
                'note': 'URI references avoid copying prepared genotype data into each step.'},
                Path(d)/'input_manifest.json')
            put(snapshot, f'{ctx.base}/input/{ctx.run_id}/input_manifest.json')
        spec = importlib.util.spec_from_file_location(f'step_{i}', HERE/STEPS[i-1]/'source'/'step.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        print(f'Starting step {i}: {STEPS[i-1]}', flush=True)
        module.execute(ctx)
        ctx.finish()
        checked.add(i)
    if args.mode in ('train', 'all'):
        with tempfile.TemporaryDirectory() as d:
            path = json_file({'complete': True, 'run_id': cfg['run_id'], 'training_people': 2003,
                              'test_people': 501, 'model': Context(cfg, 5).dest,
                              'test_results': Context(cfg, 6).dest}, Path(d)/'model_ready.json')
            put(path, f"{cfg['output_root']}/runs/{cfg['run_id']}/model_ready.json")


if __name__ == '__main__':
    main()
