#!/usr/bin/env bash
# IP 直连入口的自签证书（deploy/README.md §9）：部署时在服务器上以 root 运行一次。
#
#   deploy/generate-ip-cert.sh --ip 8.163.96.197 --dir /etc/super-error-log/tls-ip --group caddy
#
# - 证书：ECDSA P-256，SAN 只含该 IP，有效期 730 天，EKU serverAuth。
# - 私钥只留在服务器：key.pem root:<组> 0640，目录 0750；本脚本从不输出私钥内容。
# - cert.pem（只含公钥）拷回仓库 iOS/StudentApp/Resources/cloud-ip-cert.pem，由 App 固定。
# - 目标目录必须不存在（含空目录、符号链接）：不覆盖、不原地重签。换证书 = 新目录 + 新版 App。
# - 任一步失败即删除本次新建的目录（只删本脚本刚建的，不碰已有文件）。
# 依赖 OpenSSL >= 1.1.1（服务器自带）；macOS 的 LibreSSL 3.3 也可运行（本地测试用）。
set -euo pipefail

usage() {
  echo "用法：$0 --ip <公网 IPv4> --dir <新目录绝对路径> --group <Caddy 运行组>" >&2
  exit 2
}

ip=''; dir=''; group=''
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || usage
  case "$1" in
    --ip) ip="$2" ;;
    --dir) dir="$2" ;;
    --group) group="$2" ;;
    *) usage ;;
  esac
  shift 2
done
[[ -n "${ip}" && -n "${dir}" && -n "${group}" ]] || usage

# 只接受点分 IPv4，每段 0–255、无前导零：SAN 与 App 白名单按字符串精确比对。
if [[ ! "${ip}" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]]; then
  echo "错误：--ip 必须是点分 IPv4 地址：${ip}" >&2
  exit 2
fi
for octet in "${BASH_REMATCH[@]:1}"; do
  if (( octet > 255 )); then echo "错误：--ip 必须是点分 IPv4 地址：${ip}" >&2; exit 2; fi
done
if [[ "${dir}" != /* ]]; then echo "错误：--dir 必须是绝对路径：${dir}" >&2; exit 2; fi
if [[ -e "${dir}" || -L "${dir}" ]]; then
  echo "错误：${dir} 已存在；不覆盖已有证书或私钥。换证书请用新目录（deploy/README.md §9.9）。" >&2
  exit 1
fi
if [[ ! -d "$(dirname "${dir}")" ]]; then echo "错误：父目录 $(dirname "${dir}") 不存在" >&2; exit 1; fi
command -v openssl >/dev/null 2>&1 || { echo "错误：缺少 openssl" >&2; exit 1; }

umask 077
created=''
conf=''
cleanup() {
  local status=$?
  [[ -n "${conf}" ]] && rm -f "${conf}"
  if [[ ${status} -ne 0 && -n "${created}" ]]; then
    rm -rf "${dir}"
    echo "失败：已删除本次新建的 ${dir}（不含任何旧文件）。" >&2
  fi
  exit "${status}"
}
trap cleanup EXIT

# 非递归 mkdir：目录已存在时失败（检查与创建之间被抢先也不会覆盖）。
mkdir "${dir}"
created=1
conf="$(mktemp)"
cat > "${conf}" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ip
[dn]
CN = ${ip}
[v3_ip]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:${ip}
subjectKeyIdentifier = hash
EOF

# ec_param_enc:named_curve：曲线按名称编码。LibreSSL 默认写显式曲线参数，Caddy 加载时报 x509: invalid ECDSA parameters。
if ! output="$(openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -pkeyopt ec_param_enc:named_curve \
  -nodes -sha256 -days 730 \
  -config "${conf}" -keyout "${dir}/key.pem" -out "${dir}/cert.pem" 2>&1)"; then
  echo "错误：openssl 生成证书失败：${output}" >&2
  exit 1
fi

chgrp "${group}" "${dir}" "${dir}/key.pem"
chmod 0750 "${dir}"
chmod 0640 "${dir}/key.pem"
chmod 0644 "${dir}/cert.pem"

# 自检：SAN 恰为该 IP；私钥与证书配对（只比较公钥，不输出私钥）。
san="$(openssl x509 -in "${dir}/cert.pem" -noout -text | grep -A1 'Subject Alternative Name' | tail -n 1 | tr -d ' ')"
if [[ "${san}" != "IPAddress:${ip}" ]]; then echo "错误：证书 SAN 不符：${san}" >&2; exit 1; fi
if [[ "$(openssl x509 -in "${dir}/cert.pem" -noout -pubkey)" != "$(openssl pkey -in "${dir}/key.pem" -pubout)" ]]; then
  echo "错误：私钥与证书不配对" >&2
  exit 1
fi

echo "证书已生成：${dir}/cert.pem（拷回仓库供 App 固定）"
echo "私钥：${dir}/key.pem（0640，组 ${group}；只留在本机，不要拷出、不要打印）"
openssl x509 -in "${dir}/cert.pem" -noout -subject -enddate -fingerprint -sha256
