# Operator settings for PowerShell scripts (examples only; do not put real values here).
# Copy these lines to an ignored local PowerShell profile, fill in your values,
# then dot-source that file in the operator shell before running the scripts.
$env:DEVIN_OPERATOR_SSH_TARGET = 'operator@gateway.example'
$env:DEVIN_OPERATOR_SSH_KEY = 'C:\path\to\ssh-key'
$env:DEVIN_OPERATOR_GATEWAY_HOST = 'gateway.example'
$env:DEVIN_OPERATOR_NGINX_TARGET = 'operator@proxy.example'
$env:DEVIN_OPERATOR_NGINX_ADDRESS = 'proxy.example'
$env:DEVIN_HARNESS_GATEWAY = 'http://gateway.example:38643'

$env:DEVIN_OPERATOR_REMOTE_DIR = '/opt/example/gateway'
