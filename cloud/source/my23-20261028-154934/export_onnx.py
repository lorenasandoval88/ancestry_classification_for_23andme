"""Export this fitted numeric pipeline using standard ONNX tensor operators."""
import json
from pathlib import Path
import numpy as np


def numeric_parameters(pipe):
    imp, scale, pca, clf = [pipe.named_steps[s] for s in ['imputer','scale','pca','classifier']]
    if pca.whiten or not scale.with_mean or not scale.with_std or len(clf.classes_) < 3:
        raise ValueError('Exporter requires the unwhitened PCA/multinomial pipeline in this package')
    return {'impute_mean': imp.statistics_, 'scale_mean': scale.mean_, 'scale_std': scale.scale_,
              'pca_mean': pca.mean_, 'pca_weights': pca.components_.T,
              'classifier_weights': clf.coef_.T, 'classifier_bias': clf.intercept_}


def export(pipe, markers, folder):
    import onnx
    from onnx import helper as h, numpy_helper as nh, TensorProto as T
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    arrays = numeric_parameters(pipe)
    clf = pipe.named_steps['classifier']
    initializers = [nh.from_array(np.asarray(a, dtype=np.float32), name) for name,a in arrays.items()]
    nodes = [h.make_node('IsNaN',['genotypes'],['missing']),
             h.make_node('Where',['missing','impute_mean','genotypes'],['imputed']),
             h.make_node('Sub',['imputed','scale_mean'],['centered']),
             h.make_node('Div',['centered','scale_std'],['scaled']),
             h.make_node('Sub',['scaled','pca_mean'],['pca_centered']),
             h.make_node('MatMul',['pca_centered','pca_weights'],['pcs']),
             h.make_node('MatMul',['pcs','classifier_weights'],['scores']),
             h.make_node('Add',['scores','classifier_bias'],['logits']),
             h.make_node('Softmax',['logits'],['probabilities'],axis=1),
             h.make_node('ArgMax',['probabilities'],['class_index'],axis=1,keepdims=0)]
    graph = h.make_graph(nodes,'my23_v5_ancestry_model',
                         [h.make_tensor_value_info('genotypes',T.FLOAT,[None,len(markers)])],
                         [h.make_tensor_value_info('probabilities',T.FLOAT,[None,len(clf.classes_)]),
                          h.make_tensor_value_info('class_index',T.INT64,[None])], initializers)
    model = h.make_model(graph, producer_name='my23_v5_ancestry_model',opset_imports=[h.make_opsetid('',17)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    onnx.save(model,folder/'model.onnx')
    sites = []
    for variant, counted in markers:
        c,p,r,a = variant.split(':')
        if counted != r:
            raise ValueError('Export marker encoding must count REF alleles')
        sites.append([int(c),int(p),r,a])
    (folder/'markers.json').write_text(json.dumps({'genome_build':'37','sites':sites},separators=(',',':'))+'\n')
    return list(clf.classes_)


def parity(pipe, session, x, classes, atol):
    max_difference = 0.0
    for i in range(0,len(x),32):
        data = np.asarray(x[i:i+32],dtype=np.float32)
        expected = pipe.predict_proba(data)
        actual,index = session.run(['probabilities','class_index'],{'genotypes':data})
        if not np.isfinite(actual).all() or not np.array_equal(np.argmax(expected,axis=1),index):
            raise ValueError('ONNX and Python disagree on reference-group labels')
        max_difference = max(max_difference,float(np.max(np.abs(actual-expected))))
    if max_difference > atol:
        raise ValueError(f'ONNX probabilities differ from Python by {max_difference}, limit {atol}')
    return {'people_compared':len(x),'same_predicted_labels':True,
            'max_probability_absolute_difference':max_difference,'tolerance':atol,
            'runtime':'Python ONNX Runtime; actual browser compatibility is a separate check'}

