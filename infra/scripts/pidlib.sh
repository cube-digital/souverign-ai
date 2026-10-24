# Sourced by up.sh and down.sh. Needs the repo root as cwd.
# A pidfile is trusted only if the pid is alive AND its command line is the expected service;
# otherwise it is stale (e.g. a pid recycled after reboot): the file is removed, the pid never killed.

expected_cmd() { # expected_cmd <name> -> ERE matched against `ps -o command=`
  case $1 in
    llm) echo 'vllm-mlx|start-llm' ;;
    whisper) echo 'whisper-server|start-whisper' ;;
    hermes-smoke) echo 'hermes' ;;
    *) echo '^$' ;;
  esac
}

alive() { # alive <name>: true only for a live pid whose command matches the service
  local f=.run/$1.pid pid cmd
  [[ -f $f ]] || return 1
  pid=$(cat "$f")
  [[ $pid =~ ^[0-9]+$ ]] || { rm -f "$f"; return 1; }
  if kill -0 "$pid" 2>/dev/null; then
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    if [[ -n $cmd ]] && grep -Eq "$(expected_cmd "$1")" <<<"$cmd"; then return 0; fi
    echo "pid: $1 pidfile is stale (pid $pid runs: ${cmd:-?}); removing it, not killing" >&2
  fi
  rm -f "$f"
  return 1
}
