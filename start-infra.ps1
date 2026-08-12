# Start HydraOps Infrastructure
$root = "D:\HydraOps"
Write-Host "Starting infrastructure..." -ForegroundColor Cyan
# apps/nats-service is empty — NATS runs from the bundled binary
Write-Host "Starting nats-server..."
Start-Process -FilePath "$root\nats\nats-server-v2.10.22-windows-amd64\nats-server.exe" -ArgumentList "-js", "-sd", "$root\nats\jetstream" -WindowStyle Hidden
$apps = @("key-proxy", "api", "orchestrator", "outbox-worker")
foreach ($app in $apps) {
    Write-Host "Starting $app..."
    Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "apps/$app/src/index.ts" -WorkingDirectory $root -WindowStyle Hidden
}
Write-Host "Starting UI..."
Start-Process -FilePath "pnpm.cmd" -ArgumentList "--filter", "ui", "start" -WorkingDirectory $root -WindowStyle Hidden
Write-Host "Infrastructure started." -ForegroundColor Green
