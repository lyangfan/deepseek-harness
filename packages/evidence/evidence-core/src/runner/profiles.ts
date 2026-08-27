/** Versioned language-profile table for the declarative scientific-code Runner (SPEC-02 §9.1). */

export interface RunnerLanguageProfileV1 {
  readonly profileId: string
  readonly revision: string
  readonly executable: string | null
  readonly argvTemplate: readonly string[]
  readonly defaultEnvAllowlist: readonly string[]
  readonly extraEnvAllowlist: readonly string[]
  readonly scriptMediaType: string
}

/** v0.1 ships exactly one profile; r_script/python arrive via new versioned entries in later specs. */
export const BASH_LANGUAGE_PROFILE: RunnerLanguageProfileV1 = Object.freeze({
  profileId: 'bash',
  revision: 'animalge-runner-bash/v1',
  executable: null,
  argvTemplate: ['bash'],
  defaultEnvAllowlist: Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER']),
  extraEnvAllowlist: Object.freeze(['R_LIBS_USER', 'R_HOME', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS']),
  scriptMediaType: 'text/x-shellscript',
})

const REGISTERED: ReadonlyMap<string, RunnerLanguageProfileV1> = new Map([[BASH_LANGUAGE_PROFILE.profileId, BASH_LANGUAGE_PROFILE]])

/**
 * Registered profile lookup (the acceptance lane's producer registry reads the same set).
 * @param profileId Exact profile id (v0.1: 'bash').
 * @returns The frozen profile, or undefined when unregistered.
 */
export function registeredProfile(profileId: string): RunnerLanguageProfileV1 | undefined {
  return REGISTERED.get(profileId)
}

/** Capture-profile identity recorded on receipts: `runner:<profileId>`. */
export function captureProfileIdFor(profileId: string): string {
  return `runner:${profileId}`
}

export const REGISTERED_CAPTURE_PROFILE_IDS: ReadonlySet<string> = new Set([...REGISTERED.keys()].map(captureProfileIdFor))
