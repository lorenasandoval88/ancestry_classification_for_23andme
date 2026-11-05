import csv
import json
from pathlib import Path
import tempfile
import joblib
import numpy as np
import sklearn
from common import get, ids, json_file, sha, restore_bundle, publish_bundle
from ml_helpers import cross_validate, fit_model
from model_io import matrix, selected_markers, save_markers
from population_parser import read_panel


def execute(ctx):
    with tempfile.TemporaryDirectory(prefix='train-model-') as d:
        tmp = Path(d)
        if restore_bundle(ctx,tmp):
            return
        keep = get(ctx.result(2, 'train2003.keep'), tmp/'train.keep')
        people = ids(keep)
        if len(people) != 2003:
            raise ValueError('Training cohort must have exactly 2003 people')
        panel = read_panel(ctx.input('panel', tmp/'population.panel'))
        groups_file = get(ctx.result(3, 'train2003_cv_groups.tsv'), tmp/'groups.tsv')
        with groups_file.open() as f:
            groups = {r['IID']: r['GROUP'] for r in csv.DictReader(f, delimiter='\t')}
        if set(groups) != set(people):
            raise ValueError('Training CV groups do not match sample IDs')
        markers = selected_markers(ctx, tmp)
        x = matrix(ctx, people, keep, markers, tmp)
        missing = int(np.isnan(x).sum())
        if np.isnan(x).all(axis=0).any():
            raise ValueError('Selected training SNP has no observed genotypes')
        y = np.array([panel[s][1] for s in people])
        if set(y) != {'AFR','AMR','EAS','EUR','SAS'}:
            raise ValueError('Expected five broad reference groups')
        print('Starting three-fold grouped cross-validation', flush=True)
        best, scores = cross_validate(x, y, np.array([groups[s] for s in people]))
        print(f"Refitting on all 2003 training people: {best['components']} PCs; C={best['C']}", flush=True)
        pipe = fit_model(x, y, best['components'], best['C'])
        bundle = {'schema_version': 1, 'model_name': 'my23_v5_ancestry_model',
                  'pipeline': pipe, 'markers': markers, 'classes': list(pipe.classes_),
                  'training_people': 2003, 'run_id': ctx.run_id,
                  'genotype_encoding': 'count of reference allele, 0/1/2; missing=NaN'}
        joblib.dump(bundle, tmp/'model.joblib', compress=3)
        save_markers(tmp/'selected_markers.tsv', markers)
        json_file(scores, tmp/'cv_scores.json')
        report = {'status': 'trained', 'training_people': 2003, 'test_people_used': 0,
                  'selected_markers': len(markers), 'missing_genotypes': missing,
                  'total_training_genotypes': len(markers)*2003,
                  'best_parameters': {'pca_components': best['components'], 'logistic_C': best['C']},
                  'cv_accuracy': best['mean_accuracy'], 'cv_balanced_accuracy': best['mean_balanced_accuracy'],
                  'cv_method': '3-fold StratifiedGroupKFold; relatives grouped; imputer/scaler/PCA refitted per fold',
                  'cv_limitation': 'SNP QC/LD pruning used the entire training cohort before CV; validation genotypes influenced that unsupervised marker selection. The 501 test samples were not used for selection or fitting.',
                  'sklearn_version': sklearn.__version__, 'classes': list(pipe.classes_),
                  'run_id': ctx.run_id, 'config_sha256': ctx.signature,
                  'training_ids_sha256': sha(keep), 'cv_groups_sha256': sha(groups_file)}
        json_file(report, tmp/'training_summary.json')
        json_file({'model_sha256': sha(tmp/'model.joblib'), 'markers_sha256': sha(tmp/'selected_markers.tsv')},
                  tmp/'model_checksums.json')
        publish_bundle(ctx,tmp,{name:tmp/name for name in
            ['model.joblib','selected_markers.tsv','cv_scores.json','training_summary.json','model_checksums.json']})
        del x

