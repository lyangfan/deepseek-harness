# cmplot_call usage guide (fake-guide/v1)

Applies to the `cmplot_call` adapter at revision `animalge-pro-cmplot/v1`. Fake-software
contract layer only; real-software facts belong to the SPEC-07 provisioning pass.

## Inputs

- The GWAS result table (same ArtifactVersion as the report stage) via the unified input
  handle.
- Figure parameters (type, chromosome set, threshold line) are structured params.

## Operation profile

The call routes through the packaged helper script; the helper is never a second model
entry. The plot lands in the run-exclusive boundary under the declared image role.

## Outputs

The PNG figure is the formal output; the validator checks the PNG magic bytes before
finalization.

## Version notes

The helper runs under the frozen R environment revision; drift stops before process start.
