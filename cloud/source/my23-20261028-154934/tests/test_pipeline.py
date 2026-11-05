#!/usr/bin/env python3
"""Offline tests; --onnx also checks the exact export graph in ONNX Runtime."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from common import ids, load_config
from common import publish_bundle, restore_bundle
from export_onnx import export, parity, numeric_parameters
from ml_helpers import fit_model, make_folds, parse_raw
from participant_merge import merge, select_records, survey_values
from raw_parser import parse_genotypes
from bootstrap import validate_membership


class Tests(unittest.TestCase):
    def test_split_membership_accepts_formatting_and_order_differences(self):
        with tempfile.TemporaryDirectory() as d:
            actual, baseline = Path(d)/'input.txt', Path(d)/'baseline.keep'
            actual.write_bytes(b'\xef\xbb\xbfFID IID\r\n0 B\r\n0 A\r\n')
            baseline.write_text('#IID\nA\nB\n')
            result = validate_membership(actual, baseline, 2)
            self.assertTrue(result['membership_matches'])
            self.assertFalse(result['same_order'])
            self.assertNotEqual(result['input_file_sha256'], result['baseline_file_sha256'])

    def test_split_membership_rejects_changed_or_duplicate_people(self):
        with tempfile.TemporaryDirectory() as d:
            actual, baseline = Path(d)/'input.txt', Path(d)/'baseline.keep'
            baseline.write_text('#IID\nA\nB\n')
            for value in ['A\nC\n', 'A\nA\n', 'A\n']:
                actual.write_text(value)
                with self.assertRaises(ValueError):
                    validate_membership(actual, baseline, 2)

    def test_ref_dosage_missing_and_duplicates(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'raw.txt'
            path.write_text('# genome build 37\nrsid chromosome position genotype\n'
                            'a 1 10 AC\nb 1 20 TT\nc 1 30 --\nd 1 40 GG\ne 1 40 AA\nf 1 50 CC\n')
            sites={(1,10):(0,'A','C'),(1,20):(1,'T','G'),(1,30):(2,'C','A'),
                   (1,40):(3,'G','A'),(1,50):(4,'A','G')}
            x,builds,qc=parse_genotypes(path,sites,5)
            np.testing.assert_equal(x,[1,2,np.nan,np.nan,np.nan])
            self.assertEqual(builds,['37'])
            self.assertEqual(qc['conflicting_duplicates'],1)
            self.assertEqual(qc['possible_opposite_strand'],1)
            self.assertEqual(qc['incompatible_alleles'],1)

    def test_export_order_and_allele_guard(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'x.raw'
            path.write_text('FID IID PAT MAT SEX PHENOTYPE 1:20:T:G_T 1:10:A:C_A\n0 id1 0 0 0 -9 2 1\n')
            x=np.full((1,2),np.nan,dtype=np.float32)
            parse_raw(path,[('1:10:A:C','A'),('1:20:T:G','T')],{'id1':0},x,0)
            np.testing.assert_equal(x,[[1,2]])
            path.write_text(path.read_text().replace('1:20:T:G_T','1:20:T:G_G'))
            with self.assertRaises(ValueError):
                parse_raw(path,[('1:10:A:C','A'),('1:20:T:G','T')],{'id1':0},x,0)

    def test_merge_by_gcs_identity_and_preserve_profiles(self):
        p=[{'id':'huTEST','profile':{'google_survey_results':[[['What is your race? Pick all that apply.','self report']]]},
            'files':[{'chipClassification':'v5','genomeBuild':'37','genomeBuildFiles':[{'gcsPath':'geneticFiles/huTEST_1_file.txt'}]}]}]
        chips=[{'classification':'v5','genomeBuild':'37','targetBuild':'37','status':'processed',
                'objectName':'geneticFiles/huTEST_1_file.txt','fileName':'huTEST_1_file.txt','matches':{'v5':{'matchRate':1}}}]
        selection=select_records(p,chips,1,1,1)
        pred=[{'object_name':chips[0]['objectName'],'status':'classified','predicted_group':'EUR',
               'qc':{'called_fraction':1},'reference_group_probabilities':{'EUR':1}}]
        result,table,audit=merge(p,selection,pred,'unit-run')
        self.assertEqual(result[0]['profile'],p[0]['profile'])
        self.assertNotIn('ancestryClassification',p[0])
        self.assertEqual(table[0]['self_reported_race'],'self report')
        self.assertEqual(audit['predictions_joined'],1)
        self.assertEqual(result[0]['ancestryClassification']['predicted_group'],'EUR')
        wrong=copy.deepcopy(chips);wrong[0]['objectName']='geneticFiles/huTEST_2_file.txt';wrong[0]['fileName']='huTEST_2_file.txt'
        with self.assertRaises(ValueError):
            select_records(p,wrong,1,1,1)

    def test_conflicting_person_predictions_are_not_collapsed(self):
        person={'id':'huTEST','profile':{},'files':[{},{}]}
        chosen=[{'participant_index':0,'file_index':i,'participant_id':'huTEST','object_name':str(i),'file_name':str(i)} for i in range(2)]
        predictions=[{'object_name':str(i),'status':'classified','predicted_group':g,'qc':{'called_fraction':1},'reference_group_probabilities':{g:1}} for i,g in enumerate(['EUR','AMR'])]
        combined,table,audit=merge([person],chosen,predictions,'test')
        self.assertEqual(combined[0]['ancestryClassification']['status'],'conflicting_file_predictions')
        self.assertIsNone(combined[0]['ancestryClassification']['predicted_group'])

    def test_related_groups_stay_together_in_cv(self):
        y=np.array(['AFR','EUR','SAS']*30)
        groups=np.array([f'g{i//2}' for i in range(90)])
        for train,val in make_folds(y,groups):
            self.assertFalse(set(groups[train])&set(groups[val]))

    def test_configuration_and_ids(self):
        self.assertEqual(load_config()['train_samples'],2003)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'ids.txt';p.write_text('FID IID\n0 A\n0 B\n')
            self.assertEqual(ids(p),['A','B'])
            p.write_text('#IID\nA\nA\n')
            with self.assertRaises(ValueError):ids(p)

    def test_export_numeric_parameters_match_fitted_pipeline(self):
        rng=np.random.default_rng(42)
        x=rng.integers(0,3,(90,32)).astype(np.float32)
        x[0,0]=np.nan
        pipe=fit_model(x,np.array(['AFR','EUR','SAS']*30),10,1.0)
        a={k:np.asarray(v,dtype=np.float32) for k,v in numeric_parameters(pipe).items()}
        imputed=np.where(np.isnan(x),a['impute_mean'],x)
        scaled=(imputed-a['scale_mean'])/a['scale_std']
        pcs=(scaled-a['pca_mean'])@a['pca_weights']
        logits=pcs@a['classifier_weights']+a['classifier_bias']
        exponential=np.exp(logits-logits.max(axis=1,keepdims=True))
        probabilities=exponential/exponential.sum(axis=1,keepdims=True)
        np.testing.assert_allclose(probabilities,pipe.predict_proba(x),atol=0.0001,rtol=0)
        np.testing.assert_equal(probabilities.argmax(axis=1),pipe.predict_proba(x).argmax(axis=1))

    def test_partial_publication_restores_same_artifacts_without_refit(self):
        blobs={}
        events=[]
        class Ctx:
            dest='gs://test/step/results/run'
            signature='fixed-config'
            step=5
            outputs={}
            fail=True
            def publish(self,path,name):
                if name=='summary.json' and self.fail:
                    raise RuntimeError('simulated failed upload')
                uri=f'{self.dest}/{name}'
                value=Path(path).read_bytes()
                if uri in blobs and blobs[uri]!=value:
                    raise ValueError('overwrite refused')
                blobs[uri]=value;events.append(name)
                return uri
        def fake_info(uri,required=True):
            return {'generation':'1','size':str(len(blobs[uri])),'md5Hash':'x','crc32c':'y'} if uri in blobs else None
        def fake_get(uri,path):
            Path(path).write_bytes(blobs[uri]);return Path(path)
        with tempfile.TemporaryDirectory() as d:
            tmp=Path(d)
            (tmp/'model.joblib').write_bytes(b'original trained artifact')
            (tmp/'summary.json').write_text('{}')
            ctx=Ctx()
            with self.assertRaises(RuntimeError):
                publish_bundle(ctx,tmp,{name:tmp/name for name in ['model.joblib','summary.json']})
            self.assertEqual(events,['artifacts.zip','model.joblib'])
            ctx.fail=False
            with patch('common.info',fake_info),patch('common.get',fake_get):
                self.assertTrue(restore_bundle(ctx,tmp))
            self.assertEqual(blobs[f'{ctx.dest}/model.joblib'],b'original trained artifact')
            self.assertIn(f'{ctx.dest}/summary.json',blobs)


def check_onnx():
    import onnxruntime as ort
    rng=np.random.default_rng(123)
    x=rng.integers(0,3,(90,32)).astype(np.float32)
    x[0,0]=np.nan
    y=np.array(['AFR','EUR','SAS']*30)
    pipe=fit_model(x,y,10,1.0)
    markers=[(f'1:{i+1}:A:C','A') for i in range(32)]
    with tempfile.TemporaryDirectory() as d:
        classes=export(pipe,markers,d)
        session=ort.InferenceSession(str(Path(d)/'model.onnx'),providers=['CPUExecutionProvider'])
        print('Synthetic ONNX parity:',parity(pipe,session,x,classes,0.0001))


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--onnx',action='store_true');args=ap.parse_args()
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Tests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():sys.exit(1)
    if args.onnx:check_onnx()
