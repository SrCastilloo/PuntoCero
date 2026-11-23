[CmdletBinding()]
param([switch]$Cloudflare)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$project = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $project 'node_modules\wrangler\bin\wrangler.js'
if ($Cloudflare -and !(Test-Path -LiteralPath $wrangler -PathType Leaf)) {
    throw 'Ejecuta npm ci en la carpeta del proyecto antes de configurar Cloudflare.'
}

$password = Read-Host 'Contraseña de LaGlotona' -AsSecureString
$passwordBytes = $null
try {
    if ($password.Length -lt 12 -or $password.Length -gt 200) {
        throw 'La contraseña debe tener entre 12 y 200 caracteres.'
    }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    try {
        $passwordBytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }

    $salt = [byte[]]::new(16)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($salt) } finally { $random.Dispose() }
    $iterations = 100000
    $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $passwordBytes, $salt, $iterations, [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    try { $hash = $derive.GetBytes(32) } finally { $derive.Dispose() }
    $saltHex = [BitConverter]::ToString($salt).Replace('-', '').ToLowerInvariant()
    $hashHex = [BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
    $value = 'pbkdf2-sha256${0}${1}${2}' -f $iterations, $saltHex, $hashHex

    if ($Cloudflare) {
        $value | & node $wrangler pages secret put LOG_ADMIN_PASSWORD_HASH --project-name=punto-cero-la-glotona
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare no guardó el secreto de diagnóstico.' }
        return
    }

    $target = Join-Path $project '.dev.vars'
    $exists = Test-Path -LiteralPath $target -PathType Leaf
    $source = if ($exists) { $target } else { Join-Path $project '.dev.vars.example' }
    $contents = [IO.File]::ReadAllText($source)
    $contents = [regex]::Replace($contents, '(?m)^[\t ]*(?:export[\t ]+)?LOG_ADMIN_PASSWORD_HASH[\t ]*=[^\r\n]*(?:\r?\n|$)', '')
    $newline = if ($contents.Contains("`r`n")) { "`r`n" } else { "`n" }
    $temporary = "$target.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($contents.TrimEnd("`r", "`n") + $newline + "LOG_ADMIN_PASSWORD_HASH=$value" + $newline), [Text.UTF8Encoding]::new($false))
        if ($exists) { [IO.File]::Replace($temporary, $target, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $target) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
    Write-Host 'Contraseña de diagnóstico configurada para el servidor local.'
} finally {
    $password.Dispose()
    if ($null -ne $passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
}
