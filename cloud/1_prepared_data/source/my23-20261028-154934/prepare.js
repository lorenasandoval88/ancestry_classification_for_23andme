#!/usr/bin/env node
/*
 * Prepare the 1000 Genomes Phase 3 GRCh37 reference at positions represented
 * in the supplied 23andMe v5 core manifest.
 *
 * This stage is deliberately pre-QC: it performs no MAF/missingness filtering,
 * LD pruning, PCA, ancestry-marker selection, or classifier training.
 */

'use strict';

(async function main() {
  const fs = await import('node:fs/promises');
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { createGunzip } = await import('node:zlib');
  const { createInterface } = await import('node:readline');
  const { dirname, join, resolve, sep } = await import('node:path');
  const { homedir } = await import('node:os');
  const { spawn } = await import('node:child_process');

  const SCRIPT_DIR = __dirname;
  const PIPELINE_VERSION = 'my23-1.0.0';
  const DEFAULT_CHROMOSOMES = Array.from({ length: 22 }, (_, index) => index + 1);
  const options = {
    inputPrefix: 'gs://ref1000g/phase3',
    manifest: 'gs://ref1000g/ancestry/1_prepared_data/input/v5_manifest.json',
    outputPrefix: 'gs://all23_0710/ancestry/my23_v5_ancestry_model/1_prepared_data/results/REQUIRED_RUN_ID',
    trainIds: 'gs://ref1000g/ancestry/1_prepared_data/input/train2003.txt',
    testIds: 'gs://ref1000g/ancestry/1_prepared_data/input/test501.txt',
    tempBase: '/tmp',
    chromosomes: DEFAULT_CHROMOSOMES,
    threads: 2,
    expectedTrain: 2003,
    expectedTest: 501,
    dryRun: false,
    selfTest: false,
  };

  function usage() {
    return `Usage: node prepareTheData_1000G_t0_V5.js [options]

Options:
  --input-prefix URI       1000G Phase 3 VCF prefix
                           (default: gs://ref1000g/phase3)
  --manifest URI           Original v5 JSON manifest
                           (default: .../1_prepared_data/input/v5_manifest.json)
  --output-prefix URI      Prepared output prefix
                           (default: .../1_prepared_data/results)
  --train-ids URI          Supplied training IDs (default: .../input/train2003.txt)
  --test-ids URI           Supplied test IDs (default: .../input/test501.txt)
  --chromosomes LIST       Comma-separated chromosomes, e.g. 1,2,22
  --threads N              Threads passed to bcftools/PLINK 2 (default: 2)
  --tmp-dir PATH           Temporary filesystem outside the home directory
  --expected-train N       Required training count (default: 2003)
  --expected-test N        Required testing count (default: 501)
  --dry-run                Print the plan without downloading or uploading
  --self-test              Validate embedded marker inputs and core logic
  -h, --help               Show this help

The supplied split is validated and reused exactly; no samples are re-split.`;
  }

  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return;
    } else if ([
      '--input-prefix', '--manifest', '--output-prefix', '--train-ids', '--test-ids',
      '--chromosomes', '--threads', '--tmp-dir', '--expected-train', '--expected-test',
    ].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--input-prefix') options.inputPrefix = value.replace(/\/+$/, '');
      else if (arg === '--manifest') options.manifest = value;
      else if (arg === '--output-prefix') options.outputPrefix = value.replace(/\/+$/, '');
      else if (arg === '--train-ids') options.trainIds = value;
      else if (arg === '--test-ids') options.testIds = value;
      else if (arg === '--tmp-dir') options.tempBase = resolve(value);
      else if (arg === '--chromosomes') {
        const values = value.split(',').map((part) => Number(part.trim()));
        if (values.some((chrom) => !Number.isInteger(chrom) || chrom < 1 || chrom > 22)) {
          throw new Error('--chromosomes accepts comma-separated integers 1-22.');
        }
        options.chromosomes = [...new Set(values)].sort((a, b) => a - b);
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${arg} must be a positive integer.`);
        if (arg === '--threads') options.threads = parsed;
        else if (arg === '--expected-train') options.expectedTrain = parsed;
        else options.expectedTest = parsed;
      }
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  const gsPattern = /^gs:\/\/[a-z0-9][a-z0-9._-]+(?:\/[^?#\\]*)?$/;
  for (const [name, value] of [
    ['--input-prefix', options.inputPrefix],
    ['--manifest', options.manifest],
    ['--output-prefix', options.outputPrefix],
    ['--train-ids', options.trainIds],
    ['--test-ids', options.testIds],
  ]) {
    if (!gsPattern.test(value)) throw new Error(`${name} must be a gs:// URI.`);
  }
  if (options.trainIds === options.testIds) throw new Error('Training and testing ID URIs must differ.');
  if (options.inputPrefix === options.outputPrefix) throw new Error('Input and output prefixes must differ.');

  let activeChild = null;
  let cancelled = false;
  function interrupt() {
    cancelled = true;
    if (activeChild) activeChild.kill('SIGTERM');
  }
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);

  function run(command, commandArgs, { capture = false, stdoutPath = null } = {}) {
    if (cancelled) return Promise.reject(new Error('Interrupted'));
    return new Promise((accept, reject) => {
      const stdio = stdoutPath
        ? ['ignore', 'pipe', 'pipe']
        : (capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit']);
      const child = spawn(command, commandArgs, {
        stdio,
        shell: false,
        env: command === 'gcloud' ? {
          ...process.env,
          CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED: 'false',
        } : process.env,
      });
      activeChild = child;
      let stdout = '';
      let stderr = '';
      let output = null;
      if (stdoutPath) {
        output = createWriteStream(stdoutPath);
        child.stdout.pipe(output);
      } else if (capture) {
        child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
      }
      if (capture || stdoutPath) {
        child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
      }
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (activeChild === child) activeChild = null;
        const finish = () => {
          if (code === 0 && !cancelled) accept(stdout);
          else {
            const detail = stderr.trim();
            const error = new Error(`${command} failed (${signal || code})${detail ? `: ${detail}` : ''}`);
            error.stderr = stderr;
            reject(error);
          }
        };
        if (output && !output.writableFinished) output.once('finish', finish);
        else finish();
      });
    });
  }

  async function sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }

  async function md5Base64(path) {
    const hash = createHash('md5');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('base64');
  }

  async function describe(uri) {
    try {
      const text = await run('gcloud', [
        'storage', 'objects', 'describe', uri, '--raw', '--format=json',
      ], { capture: true });
      return JSON.parse(text);
    } catch (error) {
      if (!cancelled && /\b404\b|No URLs matched/i.test(error.stderr || '')) return null;
      throw error;
    }
  }

  async function download(uri, local) {
    await fs.mkdir(dirname(local), { recursive: true });
    const meta = await describe(uri);
    if (!meta) throw new Error(`Missing input: ${uri}`);
    if (process.env.EXPECTED_REFERENCES_PATH) {
      const expected = JSON.parse(await fs.readFile(process.env.EXPECTED_REFERENCES_PATH, 'utf8'))[uri];
      if (expected && String(meta.generation) !== expected.generation) {
        throw new Error(`Reference generation changed: ${uri}`);
      }
    }
    await run('gcloud', ['storage', 'cp', `${uri}#${meta.generation}`, local, '--quiet']);
  }

  async function uploadImmutable(local, uri) {
    const stat = await fs.stat(local);
    const digest = await md5Base64(local);
    const existing = await describe(uri);
    if (existing) {
      if (String(existing.size) !== String(stat.size) || (existing.md5Hash && existing.md5Hash !== digest)) {
        throw new Error(`Refusing to replace a different existing output: ${uri}`);
      }
      console.log(`SKIP existing verified output: ${uri}`);
      return 'skipped';
    }
    await run('gcloud', [
      'storage', 'cp', local, uri,
      `--content-md5=${digest}`, '--if-generation-match=0', '--quiet',
    ]);
    const stored = await describe(uri);
    if (!stored || String(stored.size) !== String(stat.size) || stored.md5Hash !== digest) {
      throw new Error(`Uploaded object failed size/MD5 verification: ${uri}`);
    }
    return 'uploaded';
  }

  function parseTsvLine(line) {
    return line.replace(/\r$/, '').split('\t');
  }

  async function readEmbeddedInputs() {
    const positionsPath = join(SCRIPT_DIR, 'v5_autosomal_b37.tsv.gz');
    const byChromosome = new Map(DEFAULT_CHROMOSOMES.map((chrom) => [chrom, []]));
    const input = createReadStream(positionsPath).pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });
    let header = null;
    let total = 0;
    for await (const line of lines) {
      if (!header) {
        header = parseTsvLine(line);
        continue;
      }
      if (!line) continue;
      const values = parseTsvLine(line);
      const row = Object.fromEntries(header.map((name, index) => [name, values[index] || '']));
      const chrom = Number(row.chromosome);
      const position = Number(row.position_grch37);
      if (!Number.isInteger(chrom) || chrom < 1 || chrom > 22 || !Number.isInteger(position) || position < 1) {
        throw new Error(`Invalid embedded v5 coordinate: ${line}`);
      }
      byChromosome.get(chrom).push({
        chromosome: chrom,
        position,
        rsidAliases: row.rsid_aliases,
        internalIdAliases: row.internal_id_aliases,
        filesPresent: row.files_present,
        fileCount: row.file_count,
        presenceRate: row.presence_rate,
        manifestClass: row.manifest_class,
      });
      total++;
    }
    if (total !== 601871) throw new Error(`Embedded v5 manifest has ${total} autosomal positions; expected 601871.`);
    for (const [chrom, rows] of byChromosome) {
      rows.sort((left, right) => left.position - right.position);
      for (let index = 1; index < rows.length; index++) {
        if (rows[index - 1].position === rows[index].position) {
          throw new Error(`Duplicate embedded v5 position: ${chrom}:${rows[index].position}`);
        }
      }
    }

    return { byChromosome, total };
  }

  async function readInputProvenance() {
    const path = join(SCRIPT_DIR, 'input_provenance.json');
    const provenance = JSON.parse(await fs.readFile(path, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(provenance.v5_manifest_json_sha256 || '')) {
      throw new Error('input_provenance.json lacks a valid v5 manifest JSON SHA-256.');
    }
    if (!Number.isSafeInteger(provenance.v5_manifest_json_size_bytes) ||
        provenance.v5_manifest_json_size_bytes < 1) {
      throw new Error('input_provenance.json lacks a valid v5 manifest JSON size.');
    }
    return provenance;
  }

  function parseIdText(text, label) {
    const ids = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const fields = line.split(/\s+/);
      if (fields.length === 1 && /^(IID|sample|sample_id)$/i.test(fields[0])) continue;
      if (fields.length === 2 && /^(FID|family_id)$/i.test(fields[0]) && /^(IID|sample_id)$/i.test(fields[1])) continue;
      if (fields.length > 2) throw new Error(`${label} has more than two columns: ${rawLine}`);
      const id = fields.length === 1 ? fields[0] : fields[1];
      if (!id || /\s/.test(id)) throw new Error(`${label} contains an invalid sample ID.`);
      ids.push(id);
    }
    if (!ids.length) throw new Error(`${label} contains no sample IDs.`);
    const unique = new Set(ids);
    if (unique.size !== ids.length) throw new Error(`${label} contains duplicate sample IDs.`);
    return ids;
  }

  async function writeKeep(path, ids) {
    await fs.writeFile(path, `#IID\n${ids.join('\n')}\n`, 'utf8');
  }

  async function readPsamIds(path) {
    const text = await fs.readFile(path, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines.shift().replace(/^#/, '').split(/\s+/);
    const iidIndex = header.indexOf('IID');
    if (iidIndex < 0) throw new Error(`PLINK sample file lacks IID column: ${path}`);
    return lines.map((line) => line.trim().split(/\s+/)[iidIndex]);
  }

  function equalSets(left, right) {
    if (left.size !== right.size) return false;
    for (const value of left) if (!right.has(value)) return false;
    return true;
  }

  function splitIds(idValue) {
    return idValue === '.' ? [] : idValue.split(';').filter(Boolean);
  }

  function makePlinkId(chrom, position, ref, alt) {
    return `${chrom}:${position}:${ref}:${alt}`;
  }

  async function readVariantRecords(path) {
    const text = await fs.readFile(path, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => {
      const [chromosome, position, id, ref, alt] = parseTsvLine(line);
      return { chromosome: Number(chromosome.replace(/^chr/i, '')), position: Number(position), id, ref, alt };
    });
  }

  function tsvEscape(value) {
    return String(value ?? '').replace(/[\t\r\n]/g, ' ');
  }

  function rowsToTsv(rows, fields) {
    return `${fields.join('\t')}\n${rows.map((row) => fields.map((field) => tsvEscape(row[field])).join('\t')).join('\n')}\n`;
  }

  async function validatePfile(prefix, expectedIds, expectedVariants, threads) {
    const check = `${prefix}.validation`;
    await run('plink2', [
      '--pfile', prefix, 'vzs', '--threads', String(threads),
      '--write-snplist', '--out', check,
    ]);
    const snplist = (await fs.readFile(`${check}.snplist`, 'utf8')).split(/\r?\n/).filter(Boolean);
    await fs.rm(`${check}.snplist`, { force: true });
    await fs.rm(`${check}.log`, { force: true });
    if (snplist.length !== expectedVariants || new Set(snplist).size !== expectedVariants) {
      throw new Error(`${prefix} has ${snplist.length} variants; expected ${expectedVariants}.`);
    }
    const actualIds = await readPsamIds(`${prefix}.psam`);
    if (!equalSets(new Set(actualIds), new Set(expectedIds))) {
      throw new Error(`${prefix} sample membership does not match the supplied split.`);
    }
    return { sampleCount: actualIds.length, variantCount: snplist.length };
  }

  async function selfTest(embedded) {
    const train = parseIdText('#IID\nA\nB\n', 'test train');
    const test = parseIdText('FID IID\nf C\n', 'test test');
    if (train.join(',') !== 'A,B' || test.join(',') !== 'C') throw new Error('ID parser self-test failed.');
    if (makePlinkId(22, 44760984, 'A', 'G') !== '22:44760984:A:G') {
      throw new Error('PLINK ID self-test failed.');
    }
    const counts = [...embedded.byChromosome.values()].reduce((sum, rows) => sum + rows.length, 0);
    if (counts !== 601871) throw new Error('Embedded position-count mismatch');
    console.log('Preparation parsers and 601,871 embedded positions checked.');
  }

  let scratch = null;
  try {
    const embedded = await readEmbeddedInputs();
    const provenance = await readInputProvenance();
    if (await sha256(join(SCRIPT_DIR, 'v5_autosomal_b37.tsv.gz')) !== provenance.positions_file_sha256) {
      throw new Error('Embedded position derivative checksum mismatch');
    }
    if (!options.selfTest && !options.dryRun && !args.includes('--output-prefix')) {
      throw new Error('Run this preparation through index.js, or explicitly supply --output-prefix');
    }
    if (options.selfTest) {
      await selfTest(embedded);
      return;
    }

    console.log(`Pipeline version: ${PIPELINE_VERSION}`);
    console.log(`Input: ${options.inputPrefix}/`);
    console.log(`v5 manifest: ${options.manifest}`);
    console.log(`Output: ${options.outputPrefix}/`);
    console.log(`Chromosomes: ${options.chromosomes.join(',')}`);
    console.log(`Embedded v5 autosomal positions: ${embedded.total}`);
    console.log('Stage boundary: position extraction + allele validation + PGEN conversion only (no model QC/PCA).');
    if (options.dryRun) {
      for (const chrom of options.chromosomes) {
        console.log(`chr${chrom}: ${embedded.byChromosome.get(chrom).length} v5 positions.`);
      }
      console.log('Preview only: no cloud reads, downloads, conversion, or uploads were performed.');
      return;
    }

    const fullRun = options.chromosomes.length === 22 &&
      options.chromosomes.every((chrom, index) => chrom === DEFAULT_CHROMOSOMES[index]);
    const rootSuccessUri = `${options.outputPrefix}/_PREPARED.json`;
    if (fullRun && await describe(rootSuccessUri)) {
      console.log(`Complete output already exists: ${rootSuccessUri}`);
      return;
    }

    const tempRoot = await fs.realpath(options.tempBase);
    const userHome = await fs.realpath(homedir());
    if (tempRoot === userHome || tempRoot.startsWith(userHome + sep)) {
      throw new Error('Choose temporary storage outside the home directory, such as /tmp.');
    }
    scratch = await fs.mkdtemp(join(tempRoot, 'prepare-1000g-v5-'));
    console.log(`Temporary workspace: ${scratch}`);

    // The bucket JSON is the authoritative source archive. The job verifies
    // its exact bytes before using the compact derivative built into the image.
    const manifestLocal = join(scratch, 'v5_manifest.json');
    await download(options.manifest, manifestLocal);
    const manifestStat = await fs.stat(manifestLocal);
    const manifestSha256 = await sha256(manifestLocal);
    if (manifestStat.size !== provenance.v5_manifest_json_size_bytes) {
      throw new Error(`v5 manifest size mismatch: bucket=${manifestStat.size}; ` +
        `expected=${provenance.v5_manifest_json_size_bytes}.`);
    }
    if (manifestSha256 !== provenance.v5_manifest_json_sha256) {
      throw new Error(`v5 manifest SHA-256 mismatch: bucket=${manifestSha256}; ` +
        `expected=${provenance.v5_manifest_json_sha256}.`);
    }
    console.log(`Verified bucket v5 manifest (${manifestStat.size} bytes; SHA-256 ${manifestSha256}).`);
    await fs.rm(manifestLocal, { force: true });

    const trainOriginal = join(scratch, 'train.original.txt');
    const testOriginal = join(scratch, 'test.original.txt');
    await download(options.trainIds, trainOriginal);
    await download(options.testIds, testOriginal);
    const trainIds = parseIdText(await fs.readFile(trainOriginal, 'utf8'), 'training IDs');
    const testIds = parseIdText(await fs.readFile(testOriginal, 'utf8'), 'testing IDs');
    if (trainIds.length !== options.expectedTrain) {
      throw new Error(`Training list has ${trainIds.length} unique IDs; expected ${options.expectedTrain}.`);
    }
    if (testIds.length !== options.expectedTest) {
      throw new Error(`Testing list has ${testIds.length} unique IDs; expected ${options.expectedTest}.`);
    }
    const testIdSet = new Set(testIds);
    const overlap = trainIds.filter((id) => testIdSet.has(id));
    if (overlap.length) throw new Error(`Train/test overlap detected (${overlap.length} IDs; first: ${overlap[0]}).`);

    const trainKeep = join(scratch, 'train2003.normalized.txt');
    const testKeep = join(scratch, 'test501.normalized.txt');
    await writeKeep(trainKeep, trainIds);
    await writeKeep(testKeep, testIds);

    const inputUploads = [
      [trainKeep, `${options.outputPrefix}/input_snapshot/train2003.normalized.txt`],
      [testKeep, `${options.outputPrefix}/input_snapshot/test501.normalized.txt`],
      [join(SCRIPT_DIR, 'v5_autosomal_b37.tsv.gz'), `${options.outputPrefix}/input_snapshot/v5_autosomal_b37.tsv.gz`],
      [join(SCRIPT_DIR, 'input_provenance.json'), `${options.outputPrefix}/input_snapshot/input_provenance.json`],
    ];
    let inputsUploaded = false;
    async function uploadInputs() {
      if (inputsUploaded) return;
      for (const [local, uri] of inputUploads) await uploadImmutable(local, uri);
      inputsUploaded = true;
    }

    const summaries = [];
    let expectedReferenceIds = null;

    for (let chromosomeIndex = 0; chromosomeIndex < options.chromosomes.length; chromosomeIndex++) {
      const chrom = options.chromosomes[chromosomeIndex];
      const label = `chr${chrom}`;
      const baseUri = `${options.outputPrefix}/chromosomes/${label}`;
      const successUri = `${baseUri}/_SUCCESS.json`;
      console.log(`\n[${chromosomeIndex + 1}/${options.chromosomes.length}] ${label}`);
      if (await describe(successUri)) {
        const doneLocal = join(scratch, `${label}.checkpoint.json`);
        await download(successUri, doneLocal);
        const checkpoint = JSON.parse(await fs.readFile(doneLocal, 'utf8'));
        if (!checkpoint.complete || !checkpoint.objects) throw new Error('Invalid chromosome checkpoint');
        for (const [uri, expected] of Object.entries(checkpoint.objects)) {
          const current = await describe(uri);
          if (!current || String(current.generation) !== String(expected.generation) ||
              current.md5Hash !== expected.md5Hash || String(current.size) !== String(expected.size)) {
            throw new Error(`Completed chromosome object changed: ${uri}`);
          }
        }
        console.log(`SKIP completed chromosome: ${successUri}`);
        const cachedSummary = join(scratch, `${label}.summary.cached.json`);
        await download(`${baseUri}/summary.json`, cachedSummary);
        summaries.push(JSON.parse(await fs.readFile(cachedSummary, 'utf8')));
        continue;
      }

      const work = join(scratch, label);
      await fs.mkdir(work, { recursive: true });
      const sourceName = `ALL.chr${chrom}.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz`;
      const sourceVcf = join(work, sourceName);
      await download(`${options.inputPrefix}/${sourceName}`, sourceVcf);
      await download(`${options.inputPrefix}/${sourceName}.tbi`, `${sourceVcf}.tbi`);
      await run('gzip', ['-t', sourceVcf]);

      const referenceText = await run('bcftools', ['query', '-l', sourceVcf], { capture: true });
      const referenceIds = referenceText.split(/\r?\n/).filter(Boolean);
      if (new Set(referenceIds).size !== referenceIds.length) throw new Error(`${label} has duplicate sample IDs.`);
      const suppliedUnion = new Set([...trainIds, ...testIds]);
      if (!equalSets(new Set(referenceIds), suppliedUnion)) {
        const missing = [...suppliedUnion].filter((id) => !new Set(referenceIds).has(id));
        const unassigned = referenceIds.filter((id) => !suppliedUnion.has(id));
        throw new Error(`${label} sample set does not equal the supplied train/test union. ` +
          `Missing from VCF: ${missing.length}; unassigned VCF samples: ${unassigned.length}.`);
      }
      if (referenceIds.length !== options.expectedTrain + options.expectedTest) {
        throw new Error(`${label} has ${referenceIds.length} VCF samples; expected ${options.expectedTrain + options.expectedTest}.`);
      }
      if (!expectedReferenceIds) expectedReferenceIds = new Set(referenceIds);
      else if (!equalSets(expectedReferenceIds, new Set(referenceIds))) {
        throw new Error(`${label} sample set differs from the first processed chromosome.`);
      }
      // Do not publish normalized split files until they have been validated
      // against at least one source VCF sample header.
      await uploadInputs();

      const manifestRows = embedded.byChromosome.get(chrom);
      const manifestByPosition = new Map(manifestRows.map((row) => [row.position, row]));
      const regions = join(work, `${label}.regions.tsv`);
      await fs.writeFile(regions, manifestRows.map((row) => `${chrom}\t${row.position}\t${row.position}`).join('\n') + '\n');

      const rawRecordsPath = join(work, `${label}.raw-position-records.tsv`);
      await run('bcftools', [
        'query', '--regions-file', regions, '--regions-overlap', '0',
        '--format', '%CHROM\t%POS\t%ID\t%REF\t%ALT\n', sourceVcf,
      ], { stdoutPath: rawRecordsPath });

      const extractedVcf = join(work, `${label}.v5.biallelic-acgt.vcf.gz`);
      await run('bcftools', [
        'view', '--no-version', '--regions-file', regions, '--regions-overlap', '0',
        '--min-alleles', '2', '--max-alleles', '2', '--types', 'snps',
        '--include', 'REF~"^[ACGT]$" && ALT~"^[ACGT]$"',
        '--threads', String(options.threads), '--output-type', 'z', '--output', extractedVcf,
        sourceVcf,
      ]);
      await run('bcftools', ['index', '--tbi', '--threads', String(options.threads), extractedVcf]);
      await run('bcftools', ['index', '--nrecords', extractedVcf], { capture: true });

      const retainedRecordsPath = join(work, `${label}.retained-records.tsv`);
      await run('bcftools', [
        'query', '--format', '%CHROM\t%POS\t%ID\t%REF\t%ALT\n', extractedVcf,
      ], { stdoutPath: retainedRecordsPath });
      const rawRecords = await readVariantRecords(rawRecordsPath);
      const retainedRecords = await readVariantRecords(retainedRecordsPath);
      for (const record of retainedRecords) {
        if (record.chromosome !== chrom || !manifestByPosition.has(record.position)) {
          throw new Error(`Extracted record is outside the v5 coordinate list: ${record.chromosome}:${record.position}`);
        }
        if (!/^[ACGT]$/.test(record.ref) || !/^[ACGT]$/.test(record.alt) || record.alt.includes(',')) {
          throw new Error(`Extracted record is not a biallelic A/C/G/T SNP: ${record.chromosome}:${record.position}`);
        }
      }
      const variantCount = retainedRecords.length;
      if (!variantCount) throw new Error(`${label} extraction produced zero variants.`);

      const variantMap = join(work, `${label}.variant_map.tsv`);
      const variantMapRows = retainedRecords.map((record) => {
        const manifest = manifestByPosition.get(record.position);
        return {
          chromosome: chrom,
          position_grch37: record.position,
          plink_variant_id: makePlinkId(chrom, record.position, record.ref, record.alt),
          source_vcf_id: record.id,
          ref: record.ref,
          alt: record.alt,
          v5_rsid_aliases: manifest.rsidAliases,
          v5_internal_id_aliases: manifest.internalIdAliases,
          v5_files_present: manifest.filesPresent,
          v5_file_count: manifest.fileCount,
          v5_presence_rate: manifest.presenceRate,
          v5_manifest_class: manifest.manifestClass,
          chip_allele_orientation_status: 'deferred_manifest_has_no_alleles',
        };
      });
      const variantMapFields = [
        'chromosome', 'position_grch37', 'plink_variant_id', 'source_vcf_id', 'ref', 'alt',
        'v5_rsid_aliases', 'v5_internal_id_aliases', 'v5_files_present', 'v5_file_count',
        'v5_presence_rate', 'v5_manifest_class', 'chip_allele_orientation_status',
      ];
      await fs.writeFile(variantMap, rowsToTsv(variantMapRows, variantMapFields));
      const variantMapGz = `${variantMap}.gz`;
      await run('gzip', ['-n', '-c', variantMap], { stdoutPath: variantMapGz });


      const allPrefix = join(work, `${label}.all`);
      await run('plink2', [
        '--vcf', extractedVcf, '--const-fid', '0', '--set-all-var-ids', '@:#:$r:$a',
        '--new-id-max-allele-len', '100', 'missing', '--threads', String(options.threads),
        '--memory', '4096', '--make-pgen', 'vzs', '--out', allPrefix,
      ]);
      const allValidation = await validatePfile(allPrefix, referenceIds, variantCount, options.threads);
      const summary = {
        schema_version: 1,
        pipeline_version: PIPELINE_VERSION,
        chromosome: chrom,
        genome_build: 'GRCh37',
        v5_manifest_positions_requested: manifestRows.length,
        raw_1000g_records_at_requested_positions: rawRecords.length,
        retained_biallelic_acgt_snp_records: variantCount,
        samples: {
          all: allValidation.sampleCount,
          train: trainIds.length,
          test: testIds.length,
        },
        variants: {
          all: allValidation.variantCount,
          train: variantCount,
          test: variantCount,
        },
        split_preserved: true,
        allele_validation: '1000G REF/ALT restricted to biallelic A/C/G/T SNPs at exact GRCh37 v5-manifest positions',
        chip_allele_orientation: 'deferred because the supplied v5 manifest has no allele/strand fields',
      };
      const summaryPath = join(work, `${label}.summary.json`);
      await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');

      const dataUploads = [];
      for (const prefix of [allPrefix]) {
        for (const extension of ['pgen', 'pvar.zst', 'psam']) {
          dataUploads.push([`${prefix}.${extension}`, `${baseUri}/${label}.${extension}`]);
        }
      }
      dataUploads.push(
        [variantMapGz, `${baseUri}/variant_map.tsv.gz`],
        [summaryPath, `${baseUri}/summary.json`],
      );
      const objects = {};
      for (const [local, uri] of dataUploads) {
        await uploadImmutable(local, uri);
        const object = await describe(uri);
        objects[uri] = {generation: String(object.generation), size: String(object.size), md5Hash: object.md5Hash};
      }
      const chromosomeSuccess = join(work, `${label}._SUCCESS.json`);
      await fs.writeFile(chromosomeSuccess, JSON.stringify({
        schema_version: 1,
        pipeline_version: PIPELINE_VERSION,
        chromosome: chrom,
        objects,
        summary_sha256: await sha256(summaryPath),
        complete: true,
      }, null, 2) + '\n');
      await uploadImmutable(chromosomeSuccess, successUri);
      summaries.push(summary);
      await fs.rm(work, { recursive: true, force: true });
    }

    // All-skipped reruns have already validated these inputs in the chromosome
    // summaries. This also verifies that immutable input objects still match.
    await uploadInputs();
    const reportName = fullRun ? 'reports' : `reports/partial_${options.chromosomes.map((chrom) => `chr${chrom}`).join('_')}`;
    const reportDir = join(scratch, reportName.replaceAll('/', '_'));
    await fs.mkdir(reportDir, { recursive: true });
    const summaryPath = join(reportDir, 'prepare_summary.json');
    const prepareSummary = {
      schema_version: 1,
      pipeline_version: PIPELINE_VERSION,
      genome_build: 'GRCh37',
      chromosomes: options.chromosomes,
      input_prefix: options.inputPrefix,
      output_prefix: options.outputPrefix,
      v5_manifest: {
        uri: options.manifest,
        size_bytes: manifestStat.size,
        sha256: manifestSha256,
        verified_against_embedded_provenance: true,
      },
      supplied_split: {
        train_uri: options.trainIds,
        test_uri: options.testIds,
        train_original_sha256: await sha256(trainOriginal),
        test_original_sha256: await sha256(testOriginal),
        train_samples: trainIds.length,
        test_samples: testIds.length,
        overlap_samples: 0,
        split_preserved: true,
      },
      v5_manifest_positions_requested: summaries.reduce((sum, row) => sum + row.v5_manifest_positions_requested, 0),
      retained_biallelic_acgt_snp_records: summaries.reduce((sum, row) => sum + row.retained_biallelic_acgt_snp_records, 0),
      chromosome_summaries: summaries.sort((left, right) => left.chromosome - right.chromosome),
      stage_boundary: 'No MAF/missingness QC, LD pruning, PCA, informative-marker selection, or model fitting was performed.',
      allele_orientation_limitation: '23andMe chip allele/strand harmonization is deferred until an actual v5 genotype profile is loaded.',
    };
    await fs.writeFile(summaryPath, JSON.stringify(prepareSummary, null, 2) + '\n');
    await uploadImmutable(summaryPath, `${options.outputPrefix}/${reportName}/prepare_summary.json`);

    if (fullRun) {
      const rootSuccess = join(scratch, '_SUCCESS.json');
      await fs.writeFile(rootSuccess, JSON.stringify({
        schema_version: 1,
        pipeline_version: PIPELINE_VERSION,
        chromosomes: options.chromosomes,
        v5_manifest_sha256: manifestSha256,
        prepare_summary_sha256: await sha256(summaryPath),
        complete: true,
      }, null, 2) + '\n');
      await uploadImmutable(rootSuccess, rootSuccessUri);
    }

    console.log('\nPreparation complete.');
    console.log(`Prepared PLINK 2 datasets: ${options.outputPrefix}/chromosomes/`);
    console.log(`Summary: ${options.outputPrefix}/${reportName}/prepare_summary.json`);
    if (!fullRun) console.log('Partial run: no root _SUCCESS.json was written.');
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (cancelled) process.exitCode = 130;
  }
})().catch((error) => {
  console.error(`\nStopped: ${error.message}`);
  console.error('Completed chromosome outputs are retained. Fix the issue and rerun the same command.');
  if (!process.exitCode) process.exitCode = 1;
});
