"""GCS integrity checks and the shared run layout. No cloud access on import."""
import base64
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
STEPS = ['1_prepared_data', '2_split_the_samples', '3_audit_pop_and_relatives',
         '4_snp_qc_and_ld_prune', '5_fit_pca_and_classifier', '6_test_model',
         '7_apply_v5_classifier']


def run(args, capture=False, **kwargs):
    env = dict(os.environ, CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED='false')
    p = subprocess.run([str(a) for a in args], env=env, text=True,
                       stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.PIPE if capture else None, **kwargs)
    if p.returncode:
        raise RuntimeError(f'{args[0]} failed ({p.returncode}): {p.stderr or "See preceding command output"}')
    return p.stdout


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with Path(path).open('rb') as f:
        for part in iter(lambda: f.read(1 << 20), b''):
            h.update(part)
    return h.digest()


def sha(path):
    return digest(path).hex()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def fingerprint(obj):
    return hashlib.sha256(canonical(obj)).hexdigest()


def info(uri, required=True):
    p = subprocess.run(['gcloud', 'storage', 'objects', 'describe', uri,
                        '--raw', '--format=json'], capture_output=True, text=True)
    if p.returncode == 0:
        return json.loads(p.stdout)
    if re.search(r'\b404\b|No URLs matched|matched no objects', p.stderr, re.I):
        if not required:
            return None
        raise FileNotFoundError(uri)
    raise RuntimeError(f'Unable to inspect {uri}: {p.stderr[-2000:]}')


def identity(meta):
    return {k: str(meta.get(k, '')) for k in ('generation', 'size', 'md5Hash', 'crc32c')}


def get(uri, path, expected=None):
    meta = info(uri)
    if expected is not None and identity(meta) != identity(expected):
        raise ValueError(f'Input object changed: {uri}. Use a new run ID.')
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    run(['gcloud', 'storage', 'cp', f"{uri}#{meta['generation']}", path, '--quiet'])
    if path.stat().st_size != int(meta['size']):
        raise ValueError(f'Download size mismatch: {uri}')
    if meta.get('md5Hash') and base64.b64encode(digest(path, 'md5')).decode() != meta['md5Hash']:
        raise ValueError(f'Download checksum mismatch: {uri}')
    return path


def put(path, uri):
    path = Path(path)
    size = str(path.stat().st_size)
    md5 = base64.b64encode(digest(path, 'md5')).decode()
    old = info(uri, False)
    if old is None:
        run(['gcloud', 'storage', 'cp', path, uri, '--if-generation-match=0',
             f'--content-md5={md5}', '--quiet'])
        old = info(uri)
    if str(old.get('size')) != size or old.get('md5Hash') != md5:
        raise ValueError(f'Refusing to replace different output: {uri}. Choose a new RUN_ID.')
    return identity(old)


def copy_object(src, dst):
    original = info(src)
    old = info(dst, False)
    if old is None:
        run(['gcloud', 'storage', 'cp', f"{src}#{original['generation']}", dst,
             '--if-generation-match=0', '--quiet'])
        old = info(dst)
    checksum = 'md5Hash' if original.get('md5Hash') else 'crc32c'
    if str(original.get('size')) != str(old.get('size')) or not original.get(checksum) or original[checksum] != old.get(checksum):
        raise ValueError(f'Conflicting existing copy: {dst}')
    return identity(old)


def json_file(value, path):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')
    return Path(path)


def tsv(path, columns, rows):
    with Path(path).open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=columns, delimiter='\t', lineterminator='\n')
        w.writeheader()
        w.writerows(rows)


def restore_bundle(ctx, tmp, cache_name='artifacts.zip'):
    """Restore an atomic trained/tested artifact set after a partial publication."""
    uri=f'{ctx.dest}/{cache_name}'
    if info(uri,False) is None:
        return False
    local=get(uri,Path(tmp)/cache_name)
    with zipfile.ZipFile(local) as z:
        header=json.loads(z.read('_ARTIFACTS.json'))
        if header['config_sha256']!=ctx.signature:
            raise ValueError('Saved artifact bundle used a different configuration')
        expected=header['files']
        if set(z.namelist())!=set(expected)|{'_ARTIFACTS.json'}:
            raise ValueError('Invalid artifact archive members')
        for name,digest_ in expected.items():
            if name.startswith('/') or '..' in Path(name).parts:
                raise ValueError('Unsafe artifact member')
            p=Path(tmp)/'restored'/name
            p.parent.mkdir(parents=True,exist_ok=True)
            p.write_bytes(z.read(name))
            if sha(p)!=digest_:
                raise ValueError('Artifact bundle checksum mismatch')
            ctx.publish(p,name)
    ctx.outputs[uri]=identity(info(uri))
    print(f'Restored verified artifact bundle for step {ctx.step}',flush=True)
    return True


def publish_bundle(ctx, tmp, files, cache_name='artifacts.zip'):
    # Upload one complete, atomic cache before publishing any canonical files.
    archive=Path(tmp)/cache_name
    manifest={name:sha(path) for name,path in files.items()}
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
        z.writestr('_ARTIFACTS.json',json.dumps({'config_sha256':ctx.signature,'files':manifest},sort_keys=True))
        for name,path in files.items():
            z.write(path,name)
    ctx.publish(archive,cache_name)
    for name,path in files.items():
        ctx.publish(path,name)


def ids(path):
    out = []
    for row in Path(path).read_text(encoding='utf-8-sig').splitlines():
        fields = row.strip().split()
        if not fields or fields[0].startswith('#') or fields in (['IID'], ['FID', 'IID']):
            continue
        if len(fields) not in (1, 2):
            raise ValueError(f'Invalid ID row in {path}')
        out.append(fields[-1])
    if not out or len(out) != len(set(out)):
        raise ValueError(f'Empty or repeated sample IDs in {path}')
    return out


def psam(path):
    lines = Path(path).read_text().splitlines()
    header = lines[0].lstrip('#').split()
    i = header.index('IID')
    out = [r.split()[i] for r in lines[1:] if r.strip()]
    if not out or len(set(out)) != len(out):
        raise ValueError('Invalid PSAM sample identities')
    return out


def pvar(path):
    text = run(['zstd', '-dc', path], capture=True)
    out = [r.split('\t')[2] for r in text.splitlines() if r and not r.startswith('#')]
    if not out or len(set(out)) != len(out):
        raise ValueError('Empty PVAR or duplicate variant IDs')
    return out


def load_config(path=None):
    uri = os.environ.get('CONFIG_URI')
    if uri and path is None:
        with tempfile.TemporaryDirectory() as d:
            p = get(uri, Path(d)/'config.json')
            if sha(p) != os.environ.get('CONFIG_SHA256'):
                raise ValueError('Deployment configuration checksum mismatch')
            cfg = json.loads(p.read_text())
    else:
        cfg = json.loads(Path(path or HERE/'config.json').read_text())
    root = cfg['output_root'].rstrip('/')
    if not re.fullmatch(r'gs://[a-z0-9._-]+/[^?#]+', root):
        raise ValueError('Invalid output_root')
    if cfg['train_samples'] != 2003 or cfg['test_samples'] != 501:
        raise ValueError('This package preserves the 2003/501 split')
    return cfg


class Context:
    def __init__(self, config, step):
        self.cfg, self.step = config, step
        self.run_id = config['run_id']
        self.base = f"{config['output_root'].rstrip('/')}/{STEPS[step-1]}"
        self.dest = f'{self.base}/results/{self.run_id}'
        self.signature = fingerprint(config)
        self.outputs = {}

    def result(self, step, filename=''):
        return f"{self.cfg['output_root'].rstrip('/')}/{STEPS[step-1]}/results/{self.run_id}" + (f'/{filename}' if filename else '')

    def completed(self):
        meta = info(f'{self.dest}/_SUCCESS.json', False)
        if meta is None:
            return False
        with tempfile.TemporaryDirectory() as d:
            value = json.loads(get(f'{self.dest}/_SUCCESS.json', Path(d)/'done.json').read_text())
        if not value.get('complete') or value.get('config_sha256') != self.signature:
            raise ValueError('Completion record has different inputs/configuration')
        for uri, expected in value['objects'].items():
            if identity(info(uri)) != expected:
                raise ValueError(f'Completed output changed: {uri}')
        print(f'Verified completed step {self.step}: {self.dest}', flush=True)
        return True

    def require_step(self, step):
        if not Context(self.cfg, step).completed():
            raise ValueError(f'Step {step} must finish first')

    def publish(self, path, name=None):
        uri = f'{self.dest}/{name or Path(path).name}'
        self.outputs[uri] = put(path, uri)
        return uri

    def finish(self):
        with tempfile.TemporaryDirectory() as d:
            done = json_file({'complete': True, 'step': self.step, 'run_id': self.run_id,
                              'config_sha256': self.signature, 'objects': self.outputs}, Path(d)/'done.json')
            put(done, f'{self.dest}/_SUCCESS.json')
        print(f'Step {self.step} complete: {self.dest}', flush=True)

    def input(self, name, path):
        item = self.cfg['staged_inputs'][name]
        return get(item['uri'], path, item['metadata'])

