# Start all HydraOps workers manually
$root = "D:\HydraOps"
Write-Host "Starting workers..." -ForegroundColor Cyan
$workers = @("worker-coder", "worker-general", "worker-graphic", "worker-video")
foreach ($worker in $workers) {
    Write-Host "Starting $worker..."
    Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "apps/$worker/src/index.ts" -WorkingDirectory $root -WindowStyle Hidden
}
Write-Host "All workers started in background." -ForegroundColor Green
