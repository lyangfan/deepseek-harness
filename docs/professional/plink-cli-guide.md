# plink_cli usage guide (fake-guide/v1)

Applies to the `plink_cli` adapter at revision `animalge-pro-plink-cli/v1` against PLINK 1.9
compatible executables. This guide covers the fake-software contract layer only; real-software
facts belong to the SPEC-07 provisioning pass.

## Inputs

- One PLINK binary trio via the unified input handle: roles `bed`, `bim`, `fam` (exact
  ArtifactVersion refs required; expected refs fail closed).
- The environment gate must hold a frozen `TestedEnvironmentRevision` matching the resolved
  `plink` executable before any process starts.

## QC operation profile

Calling without `native_args` selects the QC operation: `--maf`, `--geno`, `--mind`,
`--chr` set and `--make-bed` output semantics are mapped from structured params. Any other
combination runs `baseline_only` (no Output Plan).

## Outputs

The supported QC call declares an Output Plan with the QC'd trio plus metric reports; formal
outputs finalize atomically. Unsupported native flag combinations settle as
`succeeded + unknown + output_plan_absent + outputs=[]` with diagnostic-manifest boundary
observations only.

## Version notes

`--version` output is parsed by the adapter's version hook; mismatched revisions stop before
process start with `environment_revision_mismatch`.
