$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Este script necesita Windows.' }

$secure = Read-Host -AsSecureString 'Pega el token de PRINT_AGENT_TOKEN'
try {
    if ($secure.Length -lt 32) { throw 'El token debe tener al menos 32 caracteres.' }
    $directory = Join-Path $env:LOCALAPPDATA 'PuntoCero'
    $tokenPath = Join-Path $directory 'printer-token.dpapi'
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $encrypted = ConvertFrom-SecureString -SecureString $secure
    [IO.File]::WriteAllText($tokenPath, $encrypted)
    Write-Host 'Token guardado con DPAPI para este usuario de Windows.'
} finally {
    $secure.Dispose()
}
