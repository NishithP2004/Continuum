# Continuum's opt-in zsh collector. Source this file explicitly from .zshrc.
# Raw commands are piped over stdin and are never placed in process arguments.

autoload -Uz add-zsh-hook

typeset -g _CONTINUUM_ZSH_SESSION="${$}-${EPOCHSECONDS}-${RANDOM}"
typeset -g _CONTINUUM_ACTIVE_COMMAND=""
typeset -g _CONTINUUM_ZSH_DIR="${${(%):-%x}:A:h}"

_continuum_zsh_invoke() {
  if [[ -n "${CONTINUUM_CLI:-}" && -x "${CONTINUUM_CLI}" ]]; then
    # Forward-compatible core CLI boundary. stdin is the only raw-command channel.
    "${CONTINUUM_CLI}" collect terminal "$@"
  else
    command node "${_CONTINUUM_ZSH_DIR}/collector.mjs" "$@"
  fi
}

_continuum_zsh_preexec() {
  [[ "${CONTINUUM_ZSH_ENABLED:-1}" == "1" ]] || return 0
  local raw_command="$1"
  local command_id="${_CONTINUUM_ZSH_SESSION}-${EPOCHSECONDS}-${RANDOM}"
  _CONTINUUM_ACTIVE_COMMAND="${command_id}"
  print -rn -- "${raw_command}" | _continuum_zsh_invoke start \
    --session "${_CONTINUUM_ZSH_SESSION}" \
    --command-id "${command_id}" \
    --cwd "${PWD}" >/dev/null 2>&1
}

_continuum_zsh_precmd() {
  local command_status=$?
  local command_id="${_CONTINUUM_ACTIVE_COMMAND}"
  _CONTINUUM_ACTIVE_COMMAND=""
  [[ -n "${command_id}" ]] || return 0
  _continuum_zsh_invoke complete \
    --session "${_CONTINUUM_ZSH_SESSION}" \
    --command-id "${command_id}" \
    --exit-code "${command_status}" </dev/null >/dev/null 2>&1 &!
}

add-zsh-hook preexec _continuum_zsh_preexec
add-zsh-hook precmd _continuum_zsh_precmd
