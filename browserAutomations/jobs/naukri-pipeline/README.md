# naukri-pipeline

```
naukri-search-jobs → naukri-export → naukri-apply
```

```bash
export NAUKRI_MAX_JOBS=25
export NAUKRI_APPLY_MAX=10
npm run naukri:pipeline -- --no-dry-run
```

Dry-run (search + export + simulate apply, no live submit):

```bash
npm run naukri:pipeline -- --dry-run
```

Skip apply (search + export only):

```bash
export NAUKRI_PIPELINE_SKIP_APPLY=true
npm run naukri:pipeline -- --dry-run
```
