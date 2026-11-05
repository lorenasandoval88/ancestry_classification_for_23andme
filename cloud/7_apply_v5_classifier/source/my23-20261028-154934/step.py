from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import numpy as np
import onnxruntime as ort
from common import HERE, copy_object, get, identity, info, json_file, put, sha
from model_io import load_bundle
from participant_merge import select_records, merge
from raw_parser import load_markers, parse_genotypes


def execute(ctx):
    cfg=ctx.cfg
    with tempfile.TemporaryDirectory(prefix='apply-model-') as d:
        tmp=Path(d)
        base=ctx.input('participants',tmp/'participants.json')
        chips=ctx.input('chip_report',tmp/'chip_match_results.json')
        participants=json.loads(base.read_text())
        chosen=select_records(participants,json.loads(chips.read_text()),cfg['expected_v5_files'],
                              cfg['expected_participants'],cfg['expected_genotype_files'])
        bundle,checksums=load_bundle(ctx,tmp)
        markers,sites,ambiguous=load_markers(tmp/'selected_markers.tsv')
        pipe=bundle['pipeline']
        classes=bundle['classes']
        browser=tmp/'browser'
        browser.mkdir()
        for name in ['model.onnx','markers.json','metadata.json']:
            get(ctx.result(6,f'browser/{name}'),browser/name)
        metadata=json.loads((browser/'metadata.json').read_text())
        if (sha(browser/'model.onnx')!=metadata['model_sha256'] or
                sha(browser/'markers.json')!=metadata['markers_sha256'] or
                metadata['feature_count']!=len(markers) or metadata['classes']!=classes):
            raise ValueError('ONNX browser artifacts changed after validation')
        session=ort.InferenceSession(str(browser/'model.onnx'),providers=['CPUExecutionProvider'])
        manifest=[]
        reports=[]
        max_difference=0.0
        for i,item in enumerate(chosen,1):
            original=f"{cfg['sources']['raw_root'].rstrip('/')}/{item['object_name']}"
            original_meta=info(original)
            copied=f"{ctx.base}/input/test/files/{item['file_name']}"
            copied_meta=copy_object(original,copied)
            if identity(info(original))!=identity(original_meta):
                raise ValueError('Raw input changed during the server-side copy')
            ctx.outputs[copied]=copied_meta
            entry={**item,'source_uri':original,'source_metadata':identity(original_meta),
                   'copied_uri':copied,'copied_metadata':copied_meta}
            manifest.append(entry)
            key=hashlib.sha256(item['object_name'].encode()).hexdigest()[:20]
            individual_uri=f'{ctx.dest}/individuals/{key}.json'
            if info(individual_uri,False):
                cached=get(individual_uri,tmp/'cached.json')
                record=json.loads(cached.read_text())
                if (record.get('run_id')!=ctx.run_id or record.get('model_sha256')!=checksums['model_sha256']
                        or record.get('copied_input')!=entry or record.get('onnx_sha256')!=metadata['model_sha256']):
                    raise ValueError('Cached individual prediction belongs to different inputs')
                ctx.publish(cached,f'individuals/{key}.json')
                reports.append(record)
                max_difference=max(max_difference,record.get('onnx_python_probability_difference',0.0))
                print(f'{i}/{len(chosen)} verified cached prediction {key}',flush=True)
                continue
            raw=get(copied,tmp/('raw.txt.gz' if copied.endswith('.gz') else 'raw.txt'),copied_meta)
            vector,builds,qc=parse_genotypes(raw,sites,len(markers))
            raw.unlink()
            reasons=[]
            if builds!=['37']:
                reasons.append('header_build_not_verified_as_37')
            if qc['malformed_rows']:
                reasons.append('malformed_genotype_rows')
            if qc['called_fraction']<cfg['minimum_called_fraction']:
                reasons.append('insufficient_model_marker_coverage')
            if qc['incompatible_fraction_of_matched_coordinates']>cfg['maximum_incompatible_fraction']:
                reasons.append('excess_incompatible_alleles')
            record={'subject_id':key,'participant_id':item['participant_id'],'object_name':item['object_name'],
                    'file_name':item['file_name'],'status':'skipped' if reasons else 'classified',
                    'predicted_group':None,'reference_group_probabilities':None,'qc':qc,
                    'reasons':reasons,'raw_header_builds':builds,'ambiguous_model_sites':ambiguous,
                    'model':'my23_v5_ancestry_model','training_people':2003,'model_markers':len(markers),
                    'run_id':ctx.run_id,'model_sha256':checksums['model_sha256'],
                    'onnx_sha256':metadata['model_sha256'],'copied_input':entry,
                    'onnx_python_probability_difference':0.0,
                    'interpretation':'Reference-group prediction, not self-reported race/ethnicity or ancestry percentages.'}
            if not reasons:
                actual,index=session.run(['probabilities','class_index'],{'genotypes':vector.reshape(1,-1)})
                expected=pipe.predict_proba(vector.reshape(1,-1))
                delta=float(np.max(np.abs(actual-expected)))
                if not np.isfinite(actual).all() or int(index[0])!=int(np.argmax(expected[0])) or delta>cfg['onnx_probability_atol']:
                    raise ValueError('ONNX/Python disagreement on personal genotype file')
                max_difference=max(max_difference,delta)
                record['onnx_python_probability_difference']=delta
                record['predicted_group']=classes[int(index[0])]
                record['reference_group_probabilities']={c:float(p) for c,p in zip(classes,actual[0])}
            ctx.publish(json_file(record,tmp/'individual.json'),f'individuals/{key}.json')
            reports.append(record)
            print(f"{i}/{len(chosen)} files: {key}, {record['status']}",flush=True)
        input_manifest=json_file(manifest,tmp/'files_manifest.json')
        put(input_manifest,f'{ctx.base}/input/{ctx.run_id}/test_files_manifest.json')
        combined,table,audit=merge(participants,chosen,reports,ctx.run_id)
        ctx.publish(json_file(reports,tmp/'predictions.json'))
        ctx.publish(json_file(combined,tmp/'consolidated_participants.json'))
        ctx.publish(json_file(audit,tmp/'merge_audit.json'))
        tablefile=tmp/'v5_build37_table.csv'
        with tablefile.open('w',newline='',encoding='utf-8') as f:
            writer=csv.DictWriter(f,fieldnames=list(table[0]),lineterminator='\n')
            writer.writeheader();writer.writerows(table)
        ctx.publish(tablefile)
        counts=Counter(r['predicted_group'] for r in reports if r['status']=='classified')
        ctx.publish(json_file({'files':len(reports),'people':len({r['participant_id'] for r in chosen}),
                               'classified':sum(r['status']=='classified' for r in reports),
                               'skipped':sum(r['status']!='classified' for r in reports),
                               'predicted_group_counts_by_file':dict(counts),
                               'max_onnx_python_probability_difference':max_difference,
                               'participants_sha256':sha(base),'chip_report_sha256':sha(chips),
                               'model_sha256':checksums['model_sha256'],'run_id':ctx.run_id},tmp/'summary.json'))
        # The browser release contains model assets and code, never personal genotype files.
        for name in ['classifier.mjs','index.html','README.md']:
            shutil.copyfile(HERE/'browser'/name,browser/name)
        runtime=Path('/opt/ort/node_modules/onnxruntime-web/dist')
        runtime_files=['ort.min.mjs','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm']
        for name in runtime_files:
            path=runtime/name
            if not path.is_file():
                raise ValueError(f'Missing pinned browser runtime file: {path}')
            ctx.publish(path,f'browser/vendor/{name}')
        for name in ['model.onnx','markers.json','metadata.json','classifier.mjs','index.html','README.md']:
            ctx.publish(browser/name,f'browser/{name}')
        ctx.publish(json_file({'files':[f'vendor/{n}' for n in runtime_files],
                               'onnxruntime_web_version':'1.22.0','run_id':ctx.run_id,
                               'note':'Host this browser folder over HTTP(S). Actual browser verification still required.'},tmp/'browser_manifest.json'),
                    'browser/browser_manifest.json')
