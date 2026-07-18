#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${continuum_root}/.continuum-runtime"
dist_dir="${continuum_root}/dist"
app_bundle="${dist_dir}/Continuum.app"
daemon_pid_file="${runtime_dir}/daemon.pid"
daemon_log="${runtime_dir}/daemon.log"
app_log="${runtime_dir}/app.log"
daemon_port="${CONTINUUM_PORT:-43117}"
daemon_entrypoint="${continuum_root}/packages/continuum/dist/server/main.js"
mode="${1:-run}"

case "${mode}" in
  run|--debug|--logs|--telemetry|--verify) ;;
  *)
    echo "Usage: ./script/build_and_run.sh [--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

mkdir -p "${runtime_dir}" "${dist_dir}"

listener_pids() {
  lsof -nP -tiTCP:"${daemon_port}" -sTCP:LISTEN 2>/dev/null || true
}

is_continuum_daemon() {
  local candidate_pid="$1" candidate_command candidate_cwd
  candidate_command="$(ps -p "${candidate_pid}" -o command= 2>/dev/null || true)"
  if [[ "${candidate_command}" == *"${daemon_entrypoint}"* ]]; then
    return 0
  fi

  candidate_cwd="$(lsof -a -p "${candidate_pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
  [[ "${candidate_cwd}" == "${continuum_root}" \
    && "${candidate_command}" == *"node packages/continuum/dist/server/main.js"* ]]
}

stop_daemon_pid() {
  local candidate_pid="$1"
  kill "${candidate_pid}" 2>/dev/null || true
  for _ in {1..40}; do
    kill -0 "${candidate_pid}" 2>/dev/null || return 0
    sleep 0.1
  done
}

stop_daemon() {
  local recorded_pid="" candidate_pid
  if [[ -f "${daemon_pid_file}" ]]; then
    recorded_pid="$(tr -cd '0-9' < "${daemon_pid_file}")"
  fi

  if [[ -n "${recorded_pid}" ]] && kill -0 "${recorded_pid}" 2>/dev/null && is_continuum_daemon "${recorded_pid}"; then
    stop_daemon_pid "${recorded_pid}"
  fi

  while IFS= read -r candidate_pid; do
    [[ -n "${candidate_pid}" ]] || continue
    if is_continuum_daemon "${candidate_pid}"; then
      stop_daemon_pid "${candidate_pid}"
    fi
  done < <(listener_pids)

  rm -f "${daemon_pid_file}"
}

stop_app() {
  local app_pids app_pid
  app_pids="$(pgrep -x ContinuumApp 2>/dev/null || true)"
  [[ -n "${app_pids}" ]] || return 0

  pkill -x ContinuumApp 2>/dev/null || true
  while IFS= read -r app_pid; do
    [[ -n "${app_pid}" ]] || continue
    for _ in {1..20}; do
      kill -0 "${app_pid}" 2>/dev/null || break
      sleep 0.1
    done
  done <<< "${app_pids}"
}

stop_app
stop_daemon

remaining_listener_pids="$(listener_pids)"
if [[ -n "${remaining_listener_pids}" ]]; then
  echo "Continuum cannot start: TCP port ${daemon_port} is already owned by another process." >&2
  while IFS= read -r listener_pid; do
    [[ -n "${listener_pid}" ]] || continue
    ps -p "${listener_pid}" -o pid=,command= >&2 || true
  done <<< "${remaining_listener_pids}"
  exit 1
fi

if [[ ! -d "${continuum_root}/node_modules" ]]; then
  npm ci --prefix "${continuum_root}"
fi

npm run build --prefix "${continuum_root}"
"${continuum_root}/script/swift.sh" build --disable-sandbox --package-path "${continuum_root}/native/ContinuumApp" --product ContinuumApp
swift_bin_dir="$("${continuum_root}/script/swift.sh" build --disable-sandbox --package-path "${continuum_root}/native/ContinuumApp" --show-bin-path)"
swift_binary="${swift_bin_dir}/ContinuumApp"

if [[ ! -x "${swift_binary}" ]]; then
  echo "Swift executable was not produced at ${swift_binary}" >&2
  exit 1
fi

rm -rf "${app_bundle}"
mkdir -p "${app_bundle}/Contents/MacOS" "${app_bundle}/Contents/Resources"
cp "${swift_binary}" "${app_bundle}/Contents/MacOS/ContinuumApp"
cp "${continuum_root}/native/ContinuumApp/Info.plist" "${app_bundle}/Contents/Info.plist"

: > "${daemon_log}"
daemon_pid="$(node "${continuum_root}/script/launch_daemon.mjs" "${daemon_entrypoint}" "${daemon_log}")"
if [[ ! "${daemon_pid}" =~ ^[0-9]+$ ]]; then
  echo "Continuum daemon launcher did not return a valid process ID." >&2
  exit 1
fi
echo "${daemon_pid}" > "${daemon_pid_file}"

daemon_ready=false
for _ in {1..80}; do
  if ! kill -0 "${daemon_pid}" 2>/dev/null; then
    break
  fi
  active_listener_pids="$(listener_pids)"
  if grep -Fx "${daemon_pid}" <<< "${active_listener_pids}" >/dev/null 2>&1 \
    && curl --fail --silent "http://127.0.0.1:${daemon_port}/health" >/dev/null 2>&1 \
    && kill -0 "${daemon_pid}" 2>/dev/null; then
    daemon_ready=true
    break
  fi
  sleep 0.1
done

if [[ "${daemon_ready}" != true ]]; then
  echo "Continuum daemon failed to become ready. See ${daemon_log}" >&2
  tail -n 40 "${daemon_log}" >&2 || true
  stop_daemon
  exit 1
fi

: > "${app_log}"
if [[ "${mode}" == "--debug" ]]; then
  lldb -- "${app_bundle}/Contents/MacOS/ContinuumApp"
  exit 0
fi

open_app() {
  local open_arguments=(-n)
  if [[ -n "${CONTINUUM_DATA_DIR:-}" ]]; then
    open_arguments+=(--env "CONTINUUM_DATA_DIR=${CONTINUUM_DATA_DIR}")
  fi
  if [[ -n "${CONTINUUM_TOKEN_FILE:-}" ]]; then
    open_arguments+=(--env "CONTINUUM_TOKEN_FILE=${CONTINUUM_TOKEN_FILE}")
  fi
  if [[ -n "${CONTINUUM_TOKEN:-}" ]]; then
    open_arguments+=(--env "CONTINUUM_TOKEN=${CONTINUUM_TOKEN}")
  fi
  /usr/bin/open "${open_arguments[@]}" "${app_bundle}"
}

if [[ "${mode}" == "--verify" ]]; then
  plutil -lint "${app_bundle}/Contents/Info.plist"
  test -x "${app_bundle}/Contents/MacOS/ContinuumApp"
  curl --fail --silent "http://127.0.0.1:${daemon_port}/health" >/dev/null
  open_app
  sleep 1
  pgrep -x ContinuumApp >/dev/null
  echo "Verified staged app, daemon, and running process: ${app_bundle}"
  exit 0
fi

open_app

echo "Continuum is running."
echo "App: ${app_bundle}"
echo "Daemon log: ${daemon_log}"

if [[ "${mode}" == "--logs" ]]; then
  /usr/bin/log stream --info --style compact --predicate 'process == "ContinuumApp"'
elif [[ "${mode}" == "--telemetry" ]]; then
  /usr/bin/log stream --info --style compact --predicate 'subsystem == "dev.continuum.app"'
fi
