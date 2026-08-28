# himvp_cli usage guide (fake-guide/v1)

Applies to the `himvp_cli` adapter at revision `animalge-pro-himvp-cli/v1`. Fake-software
contract layer only; real-software facts belong to the SPEC-07 provisioning pass.

## Inputs

- Genotype matrix plus phenotype table via the unified input handle (exact ArtifactVersion
  refs; the phenotype must be the simulation-stage output, never the raw `.fam` column).
- A frozen `TestedEnvironmentRevision` binding the resolved `himvp` executable.

## Operation profile

The structured GWAS call maps model, covariates and output table; results land in the
run-exclusive output boundary with a declared Output Plan. Unsupported native flags run
`baseline_only` and never gain formal outputs.

## Outputs

The GWAS result table is the formal output role; validators check the header shape before
finalization. Everything else in the boundary stays an unclassified observation.

## Version notes

`--version` output is parsed by the version hook; drift stops before process start.
