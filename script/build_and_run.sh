#!/usr/bin/env bash
set -euo pipefail

continuum_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="${continuum_root}/.continuum-runtime"
dist_dir="${continuum_root}/dist"
app_bundle="${dist_dir}/Continuum.app"
daemon_pid_file="${runtime_dir}/daemon.pid"
daemon_log="${runtime_dir}/daemon.log"
app_log="${runtime_dir}/app.log"
mode="${1:-run}"

case "${mode}" in
  run|--debug|--logs|--telemetry|--verify) ;;
  *)
    echo "Usage: ./script/build_and_run.sh [--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

mkdir -p "${runtime_dir}" "${dist_dir}"

stop_daemon() {
  if [[ ! -f "${daemon_pid_file}" ]]; then
    return
  fi
  local daemon_pid daemon_command
  daemon_pid="$(tr -cd '0-9' < "${daemon_pid_file}")"
  if [[ -n "${daemon_pid}" ]] && kill -0 "${daemon_pid}" 2>/dev/null; then
    daemon_command="$(ps -p "${daemon_pid}" -o command= 2>/dev/null || true)"
    if [[ "${daemon_command}" == *"continuum"*"server/main.js"* ]]; then
      kill "${daemon_pid}"
      for _ in {1..40}; do
        kill -0 "${daemon_pid}" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
  rm -f "${daemon_pid_file}"
}

stop_app() {
  if pgrep -x ContinuumApp >/dev/null 2>&1; then
    pkill -x ContinuumApp
  fi
}

stop_app
stop_daemon

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
node "${continuum_root}/packages/continuum/dist/server/main.js" >> "${daemon_log}" 2>&1 &
daemon_pid=$!
echo "${daemon_pid}" > "${daemon_pid_file}"

daemon_ready=false
for _ in {1..80}; do
  if curl --fail --silent "http://127.0.0.1:43117/health" >/dev/null 2>&1; then
    daemon_ready=true
    break
  fi
  if ! kill -0 "${daemon_pid}" 2>/dev/null; then
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
  curl --fail --silent "http://127.0.0.1:43117/health" >/dev/null
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
