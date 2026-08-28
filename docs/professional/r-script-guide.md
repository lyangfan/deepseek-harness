# r_script usage guide (fake-guide/v1)

Applies to the `r_script` adapter at revision `animalge-pro-rscript/v1`. Fake-software
contract layer only; real-software facts belong to the SPEC-07 provisioning pass.

## Inputs

- `code`: one R script locator. Packaged scripts shipped with the adapter carry the
  `animalge_packaged` code origin; agent-authored scripts first captured by the call are
  `user_or_external`, and re-captures within the same session are `agent_session_generated`.
- `args`: positional script arguments passed verbatim after `--vanilla`.

## Operation profile

Declared outputs (`declared_outputs`) form the Output Plan; a script emitting the
`# FAKE-OUTPUT:` marker in the fake fixture writes exactly those roles. No declared outputs
means `baseline_only`: the run settles `succeeded + unknown + output_plan_absent` and its
boundary files stay diagnostic.

## Outputs

Each declared output is validated (existence, non-empty bytes) before formal finalization.

## Version notes

The R interpreter is resolved and digest-pinned by the environment gate; drift stops with
`environment_revision_mismatch`.
