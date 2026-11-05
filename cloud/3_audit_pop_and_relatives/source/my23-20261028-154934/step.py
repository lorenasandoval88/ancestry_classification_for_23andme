from collections import Counter
from pathlib import Path
import tempfile
from common import get, ids, json_file, sha, tsv
from population_parser import read_panel
from relatives_parser import check


def execute(ctx):
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        tr = get(ctx.result(2, 'train2003.keep'), tmp/'train.keep')
        te = get(ctx.result(2, 'test501.keep'), tmp/'test.keep')
        panel_file = ctx.input('panel', tmp/'population.panel')
        kin = ctx.input('kinship', tmp/'deg2_phase3.kin0')
        train, test, panel = ids(tr), ids(te), read_panel(panel_file)
        if set(panel) != set(train+test):
            raise ValueError('Population panel must exactly match the 2504 reference people')
        pairs, crossing, unmatched, kin_summary = check(tr, te, kin)
        if unmatched:
            raise ValueError('Published related-pair report contains unexpected sample IDs')
        parents = {s: s for s in train}

        def find(x):
            while parents[x] != x:
                parents[x] = parents[parents[x]]
                x = parents[x]
            return x

        for row in pairs:
            if row['set1'] == row['set2'] == 'train':
                a, b = find(row['id1']), find(row['id2'])
                parents[max(a, b)] = min(a, b)
        groups = [{'IID': s, 'GROUP': find(s)} for s in train]
        tsv(tmp/'train2003_cv_groups.tsv', ['IID', 'GROUP'], groups)
        for level, index in [('population', 0), ('broad_group', 1)]:
            a = Counter(panel[s][index] for s in train)
            b = Counter(panel[s][index] for s in test)
            rows = [{level: key, 'train2003': a[key], 'test501': b[key],
                     'test_fewer_than_5': b[key] < 5} for key in sorted(a.keys() | b.keys())]
            tsv(tmp/f'{level}_counts.tsv', [level, 'train2003', 'test501', 'test_fewer_than_5'], rows)
        cols = ['id1', 'id2', 'kinship', 'king_range', 'reported_relationship', 'set1', 'set2']
        tsv(tmp/'all_close_pairs.tsv', cols, pairs)
        tsv(tmp/'cross_split_pairs.tsv', cols, crossing)
        related_test = sorted({r[k] for r in crossing for k, s in [('id1','set1'), ('id2','set2')] if r[s] == 'test'})
        (tmp/'related_test_ids.txt').write_text('\n'.join(related_test)+'\n')
        report = {'training_people': 2003, 'test_people': 501, 'training_people_removed': 0,
                  'populations': len({v[0] for v in panel.values()}), 'broad_groups': len({v[1] for v in panel.values()}),
                  'populations_missing_from_train': sorted({v[0] for v in panel.values()}-{panel[s][0] for s in train}),
                  'populations_missing_from_test': sorted({v[0] for v in panel.values()}-{panel[s][0] for s in test}),
                  'published_kinship_summary': kin_summary, 'related_test_people': related_test,
                  'population_panel_sha256': sha(panel_file),
                  'note': 'All 2003 training people are retained by design. Known train/train relatives share CV groups. Cross-split relatives are reported, not removed.'}
        json_file(report, tmp/'audit_summary.json')
        for name in ['train2003_cv_groups.tsv', 'population_counts.tsv', 'broad_group_counts.tsv',
                     'all_close_pairs.tsv', 'cross_split_pairs.tsv', 'related_test_ids.txt', 'audit_summary.json']:
            ctx.publish(tmp/name)

