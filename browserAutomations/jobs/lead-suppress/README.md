# Lead suppress

Marks companies/people present in suppress lists. Defaults to example files under `data/leads/suppress/`.

```powershell
$env:LEAD_SUPPRESS_COMPANIES="data/leads/suppress/companies.example.csv"
$env:LEAD_SUPPRESS_PEOPLE="data/leads/suppress/people.example.csv"
npm run jobs:run -- lead-suppress --dry-run
```
