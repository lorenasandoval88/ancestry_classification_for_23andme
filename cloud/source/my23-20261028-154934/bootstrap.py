#!/usr/bin/env python3
"""Stage immutable inputs and source copies with Python standard library only."""
import gzip
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
from common import HERE, STEPS, copy_object, fingerprint, identity, info, json_file, load_config, put, get, sha, ids
from participant_merge import select_records


def validate_membership(actual_path, baseline_path, expected):
    """Formatting can differ; participant membership must match the saved split."""
    actual, baseline = ids(actual_path), ids(baseline_path)
    if len(actual) != expected or len(baseline) != expected:
        raise ValueError(f'Expected {expected} unique sample IDs; got {len(actual)} input and {len(baseline)} baseline')
    missing, extra = set(baseline)-set(actual), set(actual)-set(baseline)
    if missing or extra:
        raise ValueError(f'Sample membership differs from completed Step 3: {len(missing)} missing, {len(extra)} unexpected IDs')
    return {'people': expected, 'membership_matches': True, 'same_order': actual == baseline,
            'input_file_sha256': sha(actual_path), 'baseline_file_sha256': sha(baseline_path),
            'sorted_ids_sha256': fingerprint(sorted(actual))}


def verify_split(cfg, tmp):
    report, members = {}, {}
    for key, count, name in [('train', 2003, 'baseline_train2003.keep'),
                             ('test', 501, 'baseline_test501.keep')]:
        staged = cfg['staged_inputs'][key]
        actual = get(staged['uri'], tmp/f'{key}.membership.txt', staged['metadata'])
        source = cfg['baseline_split'][key]
        target = f"{cfg['output_root']}/{STEPS[1]}/input/{cfg['run_id']}/{name}"
        meta = copy_object(source, target)
        baseline = get(target, tmp/name, meta)
        report[key] = validate_membership(actual, baseline, count)
        report[key]['baseline_uri'] = source
        members[key] = set(ids(actual))
        cfg['staged_inputs'][f'baseline_{key}'] = {'uri': target, 'metadata': meta, 'original_uri': source}
        print(f'{key}: verified exact membership of {count} people against completed Step 3', flush=True)
    if members['train'] & members['test'] or len(members['train'] | members['test']) != 2504:
        raise ValueError('The supplied split must contain 2504 distinct people with no train/test overlap')
    report['train_test_overlap'] = 0
    report['total_people'] = 2504
    cfg['split_validation'] = report
    put(json_file(report, tmp/'split_validation.json'),
        f"{cfg['output_root']}/{STEPS[1]}/input/{cfg['run_id']}/split_validation.json")


def main():
    run_id=os.environ['RUN_ID']
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}',run_id):
        raise ValueError('RUN_ID must be a safe folder name')
    cfg=load_config(HERE/'config.json')
    cfg['output_root']=os.environ.get('OUTPUT_ROOT',cfg['output_root']).rstrip('/')
    cfg['run_id']=run_id
    cfg['staged_inputs']={}
    root=cfg['output_root']
    placements={'manifest':(1,'v5_manifest.json'),'train':(2,'train2003.txt'),
                'test':(2,'test501.txt'),'panel':(3,'population.panel'),
                'kinship':(3,'deg2_phase3.kin0'),'chip_report':(7,'chip_match_results.json')}
    with tempfile.TemporaryDirectory(prefix='stage-my23-') as d:
        tmp=Path(d)
        for key,(step,name) in placements.items():
            src=cfg['sources'][key]
            target=f'{root}/{STEPS[step-1]}/input/{run_id}/{name}'
            meta=copy_object(src,target)
            cfg['staged_inputs'][key]={'uri':target,'metadata':meta,'original_uri':src}
            if key in cfg['expected_sha256'] and key not in {'manifest', 'train', 'test'}:
                path=get(target,tmp/name,meta)
                if sha(path)!=cfg['expected_sha256'][key]:
                    raise ValueError(f'{key} input differs from the previously verified reference split/report')
        verify_split(cfg, tmp)
        destination=f'{root}/{STEPS[6]}/input/{run_id}/participants.json'
        participants_uri=os.environ.get('PARTICIPANTS_URI',cfg['sources']['participants'])
        meta=copy_object(participants_uri,destination)
        participants=get(destination,tmp/'participants.json',meta)
        cfg['staged_inputs']['participants']={'uri':destination,'metadata':meta,
            'original_uri':participants_uri,
            'sha256':sha(participants)}
        chips=cfg['staged_inputs']['chip_report']
        chip_file=get(chips['uri'],tmp/'chip_report.json',chips['metadata'])
        chosen=select_records(json.loads(participants.read_text()),json.loads(chip_file.read_text()),
                              cfg['expected_v5_files'],cfg['expected_participants'],cfg['expected_genotype_files'])
        cfg['selected_personal_files']=[r['object_name'] for r in chosen]
        cfg['reference_objects']={}
        for n in range(1,23):
            name=f'ALL.chr{n}.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz'
            for suffix in ['', '.tbi']:
                uri=f"{cfg['reference_root']}/{name}{suffix}"
                cfg['reference_objects'][uri]=identity(info(uri))
        # Copy only source/configuration; participants and raw genotype files never enter an image.
        entries=[]
        for path in sorted(HERE.rglob('*')):
            if not path.is_file():
                continue
            rel=path.relative_to(HERE)
            if (any(part.startswith('.') or part=='__pycache__' for part in rel.parts[:-1])
                    or (rel.name.startswith('.') and rel.name not in {'.dockerignore','.gcloudignore'})
                    or rel.parts[0] in {'inputs','node_modules'}):
                continue
            if path.suffix in {'.pyc','.zip'}:
                continue
            entries.append((path,rel.as_posix()))
        manifest={rel:sha(path) for path,rel in entries}
        cfg['source_sha256']=fingerprint(manifest)
        for path,rel in entries:
            step=next((s for s in STEPS if rel.startswith(s+'/source/')),None)
            if step:
                target=f'{root}/{step}/source/{run_id}/{rel.split("/source/",1)[1]}'
            else:
                target=f'{root}/source/{run_id}/{rel}'
                if rel=='config.json':
                    target=f'{root}/source/{run_id}/config.template.json'
            put(path,target)
        put(json_file(manifest,tmp/'source_manifest.json'),f'{root}/source/{run_id}/source_manifest.json')
        effective=json_file(cfg,tmp/'config.json')
        config_uri=f'{root}/source/{run_id}/config.json'
        put(effective,config_uri)
        local=HERE/'.deployment'
        local.mkdir(exist_ok=True)
        (local/'run.env').write_text(''.join(f'export {k}={shlex.quote(v)}\n' for k,v in {
            'RUN_ID':run_id,'OUTPUT_ROOT':root,'CONFIG_URI':config_uri,'CONFIG_SHA256':sha(effective)}.items()))
        print(f'Staged run {run_id}; verified {len(chosen)} personal files belonging to {len({r["participant_id"] for r in chosen})} people')
        print(f'Output root: {root}')


if __name__=='__main__':
    main()
