from pathlib import Path
import tempfile
from common import get, ids, json_file, psam, sha


def execute(ctx):
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        train_file = ctx.input('train', tmp/'train.txt')
        test_file = ctx.input('test', tmp/'test.txt')
        train, test = ids(train_file), ids(test_file)
        if len(train) != 2003 or len(test) != 501 or set(train) & set(test):
            raise ValueError('The original 2003/501 split is not valid')
        for n in range(1, 23):
            source = ctx.result(1, f'chromosomes/chr{n}/chr{n}.psam')
            people = psam(get(source, tmp/'chrom.psam'))
            if len(people) != 2504 or set(people) != set(train+test):
                raise ValueError(f'chr{n} does not have exactly the supplied 2504 people')
        for filename, values in [('train2003.keep', train), ('test501.keep', test)]:
            p = tmp/filename
            p.write_text('#IID\n'+'\n'.join(values)+'\n')
            ctx.publish(p)
        ctx.publish(json_file({'training_people': 2003, 'test_people': 501, 'overlap': 0,
                               'source_train_sha256': sha(train_file), 'source_test_sha256': sha(test_file),
                               'sample_order_preserved': True, 'genotypes_copied': False}, tmp/'split_summary.json'))

