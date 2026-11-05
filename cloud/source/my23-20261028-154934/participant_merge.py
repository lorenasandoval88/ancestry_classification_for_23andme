"""Join by stored GCS file identity; never by participant name or array order."""
import copy
from collections import Counter
import json
import re


def select_records(participants, chip_rows, expected_files=74, expected_participants=885, expected_total_files=1018):
    if not isinstance(participants,list) or len(participants)!=expected_participants:
        raise ValueError('Unexpected participant count in NEW consolidated JSON')
    if len({p['id'] for p in participants})!=len(participants):
        raise ValueError('Duplicate participant IDs')
    if sum(len(p.get('files',[])) for p in participants)!=expected_total_files:
        raise ValueError('Unexpected total genotype-file count')
    if not isinstance(chip_rows,list):
        raise ValueError('Chip report must be an array')
    matches={}
    for row in chip_rows:
        if row.get('classification')!='v5' or str(row.get('genomeBuild'))!='37':
            continue
        name=row.get('objectName','')
        if (row.get('status')!='processed' or str(row.get('targetBuild'))!='37'
                or not name.startswith('geneticFiles/') or '/' in name[len('geneticFiles/'):]
                or row.get('fileName')!=name.split('/')[-1] or name in matches
                or float(row.get('matches',{}).get('v5',{}).get('matchRate',0))<0.8):
            raise ValueError('An alleged build-37 v5 chip result has invalid metadata')
        matches[name]=row
    selected=[]
    seen=set()
    for pi,person in enumerate(participants):
        for fi,file in enumerate(person.get('files',[])):
            if file.get('chipClassification')!='v5' or str(file.get('genomeBuild'))!='37':
                continue
            names={m.get('gcsPath') for m in file.get('genomeBuildFiles',[]) if m.get('gcsPath') in matches}
            if len(names)!=1:
                raise ValueError('Eligible participant file lacks one unique matching chip-report GCS path')
            name=next(iter(names))
            if name in seen or not name.split('/')[-1].startswith(person['id']+'_'):
                raise ValueError('Duplicate or conflicting participant/file identity')
            seen.add(name)
            selected.append({'participant_index':pi,'file_index':fi,'participant_id':person['id'],
                             'object_name':name,'file_name':name.split('/')[-1]})
    if len(selected)!=expected_files or set(matches)!=seen:
        raise ValueError(f'Consolidated JSON and chip report must agree on exactly {expected_files} eligible files; got {len(selected)}')
    return sorted(selected,key=lambda r:r['object_name'])


def survey_values(person):
    normalize=lambda s:re.sub(r'\s+',' ',str(s)).strip().lower()
    wanted={'what is your race? pick all that apply.':'self_reported_race',
            'what is your ethnicity?':'self_reported_ethnicity',
            'race/ethnicity':'self_reported_race_ethnicity'}
    answers={v:[] for v in wanted.values()}
    for survey in (person.get('profile') or {}).get('google_survey_results',[]):
        if not isinstance(survey,list):
            continue
        for pair in survey:
            if not isinstance(pair,list) or len(pair)<2:
                continue
            field=wanted.get(normalize(pair[0]))
            if field and pair[1] not in (None,'',[]):
                val='; '.join(map(str,pair[1])) if isinstance(pair[1],list) else str(pair[1])
                if val not in answers[field]:
                    answers[field].append(val)
    return {k:'; '.join(v) for k,v in answers.items()}


def merge(participants, selected, predictions, run_id):
    data=copy.deepcopy(participants)
    # Preserve earlier classifications explicitly as history, never as this run's results.
    for person in data:
        for record in [person,*person.get('files',[])]:
            if 'ancestryClassification' in record:
                old=record.pop('ancestryClassification')
                if old not in record.setdefault('ancestryClassificationHistory',[]):
                    record['ancestryClassificationHistory'].append(old)
    lookup={r['object_name']:r for r in predictions}
    if len(lookup)!=len(predictions) or set(lookup)!={r['object_name'] for r in selected}:
        raise ValueError('Predictions and selected file identities disagree')
    table=[]
    for item in selected:
        p=data[item['participant_index']]
        f=p['files'][item['file_index']]
        report=lookup[item['object_name']]
        f['ancestryClassification']=copy.deepcopy(report)
        table.append({'participant_id':p['id'],'file_name':item['file_name'],
                      'chip':'v5','genome_build':'37','status':report['status'],
                      'predicted_group':report['predicted_group'] or '',
                      'called_fraction':report['qc']['called_fraction'],
                      **{f'prob_{c}':(report.get('reference_group_probabilities') or {}).get(c,'')
                         for c in ['AFR','AMR','EAS','EUR','SAS']},
                      **survey_values(p),'profile_url':p.get('profileUrl',''),'run_id':run_id})
    for person in data:
        values=[f['ancestryClassification'] for f in person.get('files',[]) if 'ancestryClassification' in f]
        if not values:
            continue
        classified=[r for r in values if r['status']=='classified']
        groups={r['predicted_group'] for r in classified}
        person['ancestryClassification']={'status': 'conflicting_file_predictions' if len(groups)>1 else ('classified' if groups else 'not_classified'),
            'predicted_group':next(iter(groups)) if len(groups)==1 else None,
            'classified_file_count':len(classified),'eligible_file_count':len(values),
            'run_id':run_id,'model':'my23_v5_ancestry_model',
            'interpretation':'Closest broad reference group; separate from self-reported race/ethnicity and not an ancestry mixture percentage.'}
    report={'participants_preserved':len(data),'file_records_preserved':sum(len(p.get('files',[])) for p in data),
            'selected_files':len(selected),'selected_people':len({r['participant_id'] for r in selected}),
            'predictions_joined':len(predictions),'unmatched_predictions':0,
            'conflicting_participant_predictions':sum((p.get('ancestryClassification') or {}).get('status')=='conflicting_file_predictions' for p in data),
            'profiles_preserved':all(a.get('profile')==b.get('profile') for a,b in zip(participants,data))}
    return data,table,report

