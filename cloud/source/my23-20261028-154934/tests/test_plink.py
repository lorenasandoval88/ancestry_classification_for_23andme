#!/usr/bin/env python3
"""Container gate: real VCF extraction, PGEN export, REF dosage, QC and LD flags."""
from pathlib import Path
import sys
import tempfile
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from common import run,pvar,psam
from ml_helpers import parse_raw

with tempfile.TemporaryDirectory() as d:
    tmp=Path(d)
    people=[f's{i}' for i in range(64)]
    vcf=tmp/'toy.vcf'
    vcf.write_text('##fileformat=VCFv4.2\n##contig=<ID=1,length=100000>\n'
                   '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n'
                   '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t'+'\t'.join(people)+'\n'
                   '1\t10\trs10\tA\tC\t.\tPASS\t.\tGT\t0/0\t0/1\t1/1\t./.\t0/0\t0/1\t1/1\t0/0\n'
                   '1\t20\trs20\tT\tG\t.\tPASS\t.\tGT\t1/1\t0/1\t0/0\t0/1\t1/1\t0/1\t0/0\t0/1\n'
                   '1\t30\trs30\tA\tAT\t.\tPASS\t.\tGT\t0/0\t0/1\t1/1\t0/0\t0/0\t0/1\t1/1\t0/0\n'
                   '1\t40\trs40\tA\tC,G\t.\tPASS\t.\tGT\t0/0\t0/1\t1/1\t0/0\t0/0\t0/1\t1/1\t0/0\n'
                   '1\t50\trs50\tC\tT\t.\tPASS\t.\tGT\t0/1\t0/0\t1/1\t0/1\t0/0\t1/1\t0/1\t0/0\n')
    # Use >=50 founders, avoiding PLINK's small-sample LD safeguard in this toy test.
    expanded=[]
    for line in vcf.read_text().splitlines():
        cols=line.split('\t')
        expanded.append(line if line.startswith('#') else '\t'.join(cols[:9]+cols[9:]*8))
    vcf.write_text('\n'.join(expanded)+'\n')
    run(['bcftools','view','-Oz','-o',tmp/'source.vcf.gz',vcf])
    run(['bcftools','index','--tbi',tmp/'source.vcf.gz'])
    regions=tmp/'regions.tsv';regions.write_text('1\t10\t10\n1\t20\t20\n1\t30\t30\n1\t40\t40\n1\t50\t50\n')
    run(['bcftools','view','--regions-file',regions,'--regions-overlap','0',
         '--min-alleles','2','--max-alleles','2','--types','snps',
         '--include','REF~"^[ACGT]$" && ALT~"^[ACGT]$"','-Oz','-o',tmp/'selected.vcf.gz',tmp/'source.vcf.gz'])
    run(['plink2','--vcf',tmp/'selected.vcf.gz','--const-fid','0','--set-all-var-ids','@:#:$r:$a',
         '--memory','640','--make-pgen','vzs','--out',tmp/'reference'])
    expected=[('1:10:A:C','A'),('1:20:T:G','T'),('1:50:C:T','C')]
    assert pvar(tmp/'reference.pvar.zst')==[v for v,a in expected]
    assert psam(tmp/'reference.psam')==people
    allele_file=tmp/'alleles.txt';allele_file.write_text('1:10:A:C\tA\n1:20:T:G\tT\n1:50:C:T\tC\n')
    run(['plink2','--pfile',tmp/'reference','vzs','--export','A','--export-allele',allele_file,
         '--memory','640','--out',tmp/'dosages'])
    x=np.empty((64,3),dtype=np.float32)
    parse_raw(tmp/'dosages.raw',expected,{s:i for i,s in enumerate(people)},x,0)
    np.testing.assert_equal(x[:,0],np.tile([2,1,0,np.nan,2,1,0,2],8))
    np.testing.assert_equal(x[:,1],np.tile([0,1,2,1,0,1,2,1],8))
    np.testing.assert_equal(x[:,2],np.tile([1,2,0,1,2,0,1,2],8))
    run(['plink2','--pfile',tmp/'reference','vzs','--geno','0.02','--maf','0.01','--memory','640',
         '--make-pgen','vzs','--out',tmp/'qc'])
    assert pvar(tmp/'qc.pvar.zst')==['1:20:T:G','1:50:C:T']
    run(['plink2','--pfile',tmp/'qc','vzs','--indep-pairwise','200kb','0.5','--memory','640','--out',tmp/'ld'])
    selected=set((tmp/'ld.prune.in').read_text().split())
    assert selected and selected <= {'1:20:T:G','1:50:C:T'}
print('Real PLINK/bcftools extraction, REF dosage, missingness QC, and LD flags passed')
