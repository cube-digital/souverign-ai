# Sourced by dev.sh and demo.sh: load .env, then make sure local secrets exist (generated once, 0600).
if [[ -f .env ]]; then set -a; source .env; set +a; fi
mkdir -p .run
ensure_secret() { # ensure_secret <ENV_NAME> <file under .run>
  local name=$1 file=.run/$2
  if [[ -z "${!name:-}" ]]; then
    if [[ ! -f $file ]]; then (umask 077; openssl rand -hex 32 >"$file"); fi
    export "$name"="$(cat "$file")"
  fi
}
ensure_secret RELAY_ADMIN_TOKEN relay-admin.token
ensure_secret BRIDGE_MASTER_KEY bridge-master.key
