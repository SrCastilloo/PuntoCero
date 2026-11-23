[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'List')]
    [switch]$ListPrinters,
    [Parameter(Mandatory, ParameterSetName = 'Test')]
    [switch]$TestPrint,
    [Parameter(Mandatory, ParameterSetName = 'Preview')]
    [switch]$DryRun,
    [Parameter(ParameterSetName = 'Preview')]
    [Parameter(ParameterSetName = 'Test')]
    [ValidateSet('Mesa', 'Recogida', 'Domicilio', 'Copia', 'Historica')]
    [string]$Scenario = 'Mesa',
    [Parameter(ParameterSetName = 'Run')]
    [Parameter(ParameterSetName = 'Test')]
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$bridgeLogMessages = @{
    bridge_started = 'Puente de impresión iniciado.'
    bridge_stopped = 'Puente de impresión detenido.'
    bridge_already_running = 'Ya hay un puente en esta sesión de Windows.'
    bridge_internal_error = 'El puente se detuvo por un error interno. Revisa los avisos anteriores.'
    windows_required = 'Ejecuta el puente con Windows PowerShell (powershell.exe) en Windows.'
    config_missing = 'Falta printer.config.json. Copia el ejemplo y ajusta la cola de Windows.'
    config_invalid = 'Revisa el formato JSON y los campos siteUrl (HTTPS), printerName y pollSeconds (3 a 60).'
    driver_load_error = 'No se pudo cargar el componente de impresión. Comprueba los archivos del puente.'
    printer_list_error = 'No se pudieron consultar las impresoras de Windows.'
    printer_list_empty = 'Windows no informa de impresoras instaladas.'
    printer_test_failed = 'La prueba falló. Revisa el nombre de la cola, el papel de 80 mm y el controlador.'
    printer_test_sent = 'Prueba enviada a la cola de Windows. Comprueba el papel.'
    token_unreadable = 'No se pudo leer la clave. Ejecuta Save-PrinterToken.ps1 con este usuario de Windows.'
    token_rejected = 'La web rechazó la credencial. Comprueba PRINT_AGENT_TOKEN y vuelve a guardar la clave.'
    bridge_printer_ready = 'La cola de Windows está disponible. Comprueba el papel al recibir un ticket.'
    bridge_printer_unavailable = 'Cola no disponible. Comprueba el nombre, el controlador y el papel de 80 mm.'
    bridge_claim_unreachable = 'La cola web no responde. Se reintentará la consulta.'
    bridge_claim_recovered = 'Se recuperó la conexión con la cola web.'
    bridge_claim_rejected = 'La web rechazó la consulta. Revisa siteUrl y la versión publicada.'
    bridge_result_unreachable = 'No llegó la confirmación de la web. Solo se reenviará el resultado del mismo intento.'
    bridge_result_recovered = 'Se recuperó la conexión para confirmar la impresión.'
    bridge_ack_conflict = 'La web rechazó la confirmación del intento. Revisa su estado en el panel.'
    bridge_result_rejected = 'La web rechazó el resultado. Revisa el estado del intento en el panel.'
    bridge_ticket_invalid = 'No se pudo preparar un ticket. El intento no se envió a la cola de Windows.'
    bridge_print_uncertain = 'Windows devolvió un error durante el envío. Comprueba la cola y el papel.'
    bridge_print_confirmed = 'La web registró un envío a la cola de Windows.'
    bridge_telemetry_inactive = 'La web no recibe el estado del puente. La cola y las confirmaciones siguen activas.'
    bridge_telemetry_recovered = 'La web volvió a recibir el estado del puente.'
}
$script:bridgeLogWarning = $false

function Write-BridgeLog([string]$Code) {
    if (!$bridgeLogMessages.ContainsKey($Code)) { return }
    $line = '[{0:yyyy-MM-dd HH:mm:ss zzz}] {1} {2}' -f [datetimeoffset]::Now, $Code, $bridgeLogMessages[$Code]
    try {
        $directory = Join-Path $env:LOCALAPPDATA 'PuntoCero'
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $path = Join-Path $directory 'print-bridge.log'
        $logLock = [Threading.Mutex]::new($false, 'Local\PuntoCeroComandasLog')
        $locked = $false
        try {
            try { $locked = $logLock.WaitOne(250) }
            catch [Threading.AbandonedMutexException] { $locked = $true }
            if (!$locked) { throw 'El registro está ocupado.' }
            if ([IO.File]::Exists($path) -and [IO.FileInfo]::new($path).Length -ge 1MB) {
                $backup = $path + '.1'
                try {
                    if ([IO.File]::Exists($backup)) {
                        [IO.File]::Replace($path, $backup, [NullString]::Value)
                    } else {
                        [IO.File]::Move($path, $backup)
                    }
                } catch [IO.IOException] {
                    # Un lector puede impedir la rotación. Se conserva el registro actual.
                }
            }
            [IO.File]::AppendAllText($path, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        } finally {
            if ($locked) { $logLock.ReleaseMutex() }
            $logLock.Dispose()
        }
    } catch {
        if (!$script:bridgeLogWarning) {
            Write-Host 'No se pudo guardar el registro local del puente.'
            $script:bridgeLogWarning = $true
        }
    }
    Write-Host $line
}

function Stop-Bridge([string]$Code) {
    Write-BridgeLog $Code
    exit 1
}

function Get-BridgeConfig([string]$Path) {
    $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $site = $null
    if (-not [uri]::TryCreate($config.siteUrl, [UriKind]::Absolute, [ref]$site) -or
        $site.Scheme -ne 'https' -or $site.UserInfo -or $site.AbsolutePath -ne '/' -or
        $site.Query -or $site.Fragment) {
        throw 'siteUrl debe ser un origen HTTPS, por ejemplo https://mi-web.pages.dev.'
    }
    if ($config.printerName -isnot [string] -or [string]::IsNullOrWhiteSpace($config.printerName)) {
        throw 'printerName debe coincidir con el nombre de la cola de Windows.'
    }
    if (($config.pollSeconds -isnot [int] -and $config.pollSeconds -isnot [long]) -or
        $config.pollSeconds -lt 3 -or $config.pollSeconds -gt 60) {
        throw 'pollSeconds debe ser un entero entre 3 y 60.'
    }
    return @{ Origin = $site.GetLeftPart([UriPartial]::Authority); Printer = $config.printerName; Poll = [int]$config.pollSeconds }
}

function Get-PrinterCredential {
    $tokenPath = Join-Path $env:LOCALAPPDATA 'PuntoCero\printer-token.dpapi'
    try {
        $secure = Get-Content -LiteralPath $tokenPath -Raw | ConvertTo-SecureString
        try { return [Net.NetworkCredential]::new('', $secure) }
        finally { $secure.Dispose() }
    } catch {
        throw 'No se pudo leer la clave de la impresora. Ejecuta Save-PrinterToken.ps1 con este usuario de Windows.'
    }
}

function ConvertTo-Line([object]$Value) {
    return ([regex]::Replace([string]$Value, '[\p{Cc}\p{Cf}\s]+', ' ')).Trim()
}

function Format-TicketMoney([long]$Cents) {
    $culture = [Globalization.CultureInfo]::GetCultureInfo('es-ES')
    return (([decimal]$Cents / 100).ToString('0.00', $culture) + ' €')
}

function New-TicketRows([object]$Job) {
    $rows = [Collections.Generic.List[string]]::new()
    $rows.Add('^LA BARCA')
    $rows.Add('^PUNTOCERO LA BARCA')
    $rows.Add('^TLF.678961602')
    $rows.Add('')
    if ($Job.isCopy) { $rows.Add('^!COPIA · REIMPRESIÓN') }
    $service = if ($Job.PSObject.Properties['service']) { $Job.service }
    $location = switch ([string]$service) {
        'table' { 'Principal - MESA {0}' -f $Job.tableNumber }
        'pickup' {
            $label = 'Principal - LLEVAR'
            $reference = ConvertTo-Line $Job.reference
            if ($reference) { $label += ' - ' + $reference }
            $label
        }
        'delivery' { 'DOMICILIO' }
        default { ConvertTo-Line $Job.table }
    }
    $rows.Add(('Mesa: {0}' -f $location))
    $madrid = [TimeZoneInfo]::FindSystemTimeZoneById('Romance Standard Time')
    # ConvertFrom-Json in newer PowerShell versions can return a DateTime.
    $time = if ($Job.createdAt -is [datetime]) {
        [datetimeoffset]$Job.createdAt
    } else {
        [datetimeoffset]::Parse([string]$Job.createdAt, [Globalization.CultureInfo]::InvariantCulture)
    }
    $printedTime = [TimeZoneInfo]::ConvertTime($time, $madrid).ToString('dd/MM/yyyy HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    $rows.Add(('Fecha: {0}' -f $printedTime))
    $account = if ($Job.PSObject.Properties['accountNumber'] -and $null -ne $Job.accountNumber) {
        $Job.accountNumber
    } else { '-' }
    $rows.Add(('Cuenta: {0}' -f $account))
    $rows.Add(('Comanda: {0}' -f $Job.number))
    if ($service -eq 'delivery') {
        $delivery = $Job.delivery
        $zone = switch ($delivery.zone) {
            'la-barca' { 'La Barca' }
            'mc' { 'MC' }
            default { throw 'La comanda tiene una zona de reparto inválida.' }
        }
        $rows.Add(('Zona: {0}' -f $zone))
        $rows.Add(('Dirección: {0}' -f (ConvertTo-Line $delivery.address)))
        $rows.Add(('Teléfono: {0}' -f (ConvertTo-Line $delivery.phone)))
    }

    $rows.Add('[linea]')
    $rows.Add('!GRUPO 1')
    foreach ($line in $Job.lines) {
        $name = ConvertTo-Line $line.name
        if (-not $name -or $line.quantity -lt 1) { throw 'La comanda tiene una línea inválida.' }
        $rows.Add(('{0} {1}' -f $line.quantity, $name))
        $variant = ConvertTo-Line $line.variant
        if ($variant) { $rows.Add(('Formato: {0}' -f $variant)) }
        $note = ConvertTo-Line $line.note
        if ($note) { $rows.Add(('Nota: {0}' -f $note)) }
    }
    $note = ConvertTo-Line $Job.note
    if ($note) { $rows.Add(('Nota de la comanda: {0}' -f $note)) }

    if ($service -eq 'delivery') {
        $payment = switch ($delivery.payment) {
            'change' { 'Necesita cambio' }
            'card' { 'Tarjeta' }
            'exact' { 'Importe justo' }
            default { throw 'La comanda tiene un método de pago inválido.' }
        }
        $rows.Add('[linea]')
        $rows.Add(('Pago: {0}' -f $payment))
        $rows.Add(('Subtotal: {0}' -f (Format-TicketMoney $Job.subtotalCents)))
        $rows.Add(('Envío: {0}' -f (Format-TicketMoney $Job.deliveryFeeCents)))
        $rows.Add(('!Total a cobrar: {0}' -f (Format-TicketMoney $Job.totalCents)))
        if ($delivery.payment -eq 'change' -and $delivery.PSObject.Properties['cashCents'] -and $null -ne $delivery.cashCents) {
            $rows.Add(('Pagará con: {0}' -f (Format-TicketMoney $delivery.cashCents)))
            $rows.Add(('Cambio: {0}' -f (Format-TicketMoney ($delivery.cashCents - $Job.totalCents))))
        }
    }
    $rows.Add('')
    $rows.Add('^--- FIN DE LA COMANDA ---')
    return $rows.ToArray()
}

function New-DemoTicket([string]$Type) {
    $job = [ordered]@{
        number = 42
        table = 'Mesa 14'
        note = 'Ticket de prueba. No preparar.'
        createdAt = '2026-11-23T12:18:15.000Z'
        isCopy = $false
        service = 'table'
        tableNumber = 14
        accountNumber = 17
        reference = $null
        delivery = $null
        subtotalCents = 1870
        deliveryFeeCents = 0
        totalCents = 1870
        lines = @(
            [pscustomobject]@{name = 'Hamburguesa de la casa'; variant = 'Menú'; quantity = 2; note = 'Una sin cebolla'}
            [pscustomobject]@{name = 'Café con leche'; variant = ''; quantity = 1; note = ''}
        )
    }
    switch ($Type) {
        'Recogida' {
            $job.service = 'pickup'
            $job.reference = 'Pedido de prueba'
        }
        'Domicilio' {
            $job.service = 'delivery'
            $job.delivery = [pscustomobject]@{
                zone = 'mc'
                address = 'Calle de Ejemplo, 1'
                phone = '000 000 000'
                payment = 'change'
                cashCents = 3000
            }
            $job.deliveryFeeCents = 300
            $job.totalCents = 2170
        }
        'Copia' { $job.isCopy = $true }
        'Historica' {
            $job.Remove('service')
            $job.Remove('accountNumber')
            $job.Remove('tableNumber')
            $job.table = 'Barra (prueba local)'
        }
    }
    return [pscustomobject]$job
}

function Invoke-BridgeApi([string]$Route, [hashtable]$Payload) {
    $json = ConvertTo-Json -InputObject $Payload -Depth 5 -Compress
    $options = @{
        Uri = $config.Origin + $Route
        Method = 'Post'
        UseBasicParsing = $true
        MaximumRedirection = 0
        TimeoutSec = 15
        ContentType = 'application/json; charset=utf-8'
        Headers = @{ Authorization = ('Bearer ' + $credential.Password); Accept = 'application/json' }
        Body = [Text.Encoding]::UTF8.GetBytes($json)
    }
    try {
        $response = Invoke-WebRequest @options
    } catch {
        $code = 0
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        if ($responseProperty -and $responseProperty.Value) { $code = [int]$responseProperty.Value.StatusCode }
        return @{ Code = $code; Data = $null }
    }
    $code = [int]$response.StatusCode
    try { $data = ConvertFrom-Json -InputObject $response.Content }
    catch { return @{ Code = 502; Data = $null } }
    return @{ Code = $code; Data = $data }
}

function New-BridgeTelemetry {
    try {
        Add-Type -AssemblyName System.Net.Http
        $handler = [Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $client = [Net.Http.HttpClient]::new($handler)
        $client.Timeout = [timespan]::FromSeconds(4)
        $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $credential.Password)
        return @{
            Client = $client
            Clock = [Diagnostics.Stopwatch]::StartNew()
            Events = [Collections.Generic.List[string]]::new()
            InFlight = $null
            LastState = ''
            NextPulse = 0
            RetryAt = 0
            Failing = $false
        }
    } catch {
        Write-BridgeLog 'bridge_telemetry_inactive'
        return $null
    }
}

function Update-BridgeTelemetry([string]$Event) {
    if ($null -eq $telemetry) { return }
    if ($Event -and $Event -notin $telemetry.Events) {
        $telemetry.Events.Add($Event)
    }
    $now = $telemetry.Clock.Elapsed.TotalSeconds
    $sent = $telemetry.InFlight
    if ($null -ne $sent) {
        if (!$sent.Task.IsCompleted) { return }
        $code = 0
        try {
            $response = $sent.Task.GetAwaiter().GetResult()
            try { $code = [int]$response.StatusCode }
            finally { $response.Dispose() }
        } catch {
            # Telemetry has no bearing on the claim or its confirmation.
        } finally {
            $sent.Request.Dispose()
            $telemetry.InFlight = $null
        }
        if ($code -eq 200) {
            if ($sent.Event) { [void]$telemetry.Events.Remove($sent.Event) }
            $telemetry.LastState = $sent.State
            $telemetry.NextPulse = $sent.Time + 60
            if ($telemetry.Failing) { Write-BridgeLog 'bridge_telemetry_recovered' }
            $telemetry.Failing = $false
        } else {
            $retryDelay = if ($code -eq 404 -or $code -eq 405) { 300 } else { 60 }
            $telemetry.RetryAt = $now + $retryDelay
            if (!$telemetry.Failing) { Write-BridgeLog 'bridge_telemetry_inactive' }
            $telemetry.Failing = $true
            return
        }
    }

    if ($now -lt $telemetry.RetryAt -or !$printer.State) { return }
    if ($telemetry.Events.Count -eq 0 -and $now -lt $telemetry.NextPulse -and $printer.State -eq $telemetry.LastState) { return }
    $nextEvent = if ($telemetry.Events.Count) { $telemetry.Events[0] }
    $payload = @{ state = $printer.State }
    if ($nextEvent) { $payload.event = $nextEvent }
    $request = $null
    try {
        $url = $config.Origin + '/api/impresora/telemetria'
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, $url)
        $json = ConvertTo-Json -InputObject $payload -Compress
        $request.Content = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
        $task = $telemetry.Client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead)
        $telemetry.InFlight = @{ Task = $task; Request = $request; State = $printer.State; Event = $nextEvent; Time = $now }
    } catch {
        if ($null -ne $request) { $request.Dispose() }
        $telemetry.RetryAt = $now + 60
        if (!$telemetry.Failing) { Write-BridgeLog 'bridge_telemetry_inactive' }
        $telemetry.Failing = $true
    }
}

function Update-BridgePrinter {
    $state = 'ready'
    try { [PuntoCero.TicketPrinter]::Check($config.Printer) }
    catch { $state = 'unavailable' }
    if ($state -ne $printer.State) {
        $printer.State = $state
        if ($state -eq 'ready') { Write-BridgeLog 'bridge_printer_ready' }
        else { Write-BridgeLog 'bridge_printer_unavailable' }
    }
    Update-BridgeTelemetry
}

function Wait-BridgeRetry([int]$Seconds) {
    while ($Seconds -gt 0) {
        $step = [Math]::Min($Seconds, 10)
        Start-Sleep -Seconds $step
        $Seconds -= $step
        Update-BridgeTelemetry
    }
}

function Confirm-PrintResult([hashtable]$Payload) {
    $pause = [Math]::Min($config.Poll, 30)
    $retrying = $false
    while ($true) {
        $response = Invoke-BridgeApi '/api/impresora/result' $Payload
        if ($response.Code -eq 200 -and $response.Data -and $response.Data.PSObject.Properties['ok'] -and
            $response.Data.ok -eq $true) {
            if ($retrying) { Write-BridgeLog 'bridge_result_recovered' }
            return $true
        }
        if ($response.Code -eq 409) {
            Write-BridgeLog 'bridge_ack_conflict'
            Update-BridgeTelemetry 'bridge_ack_conflict'
            return $false
        }
        if ($response.Code -eq 401 -or $response.Code -eq 403) {
            Stop-Bridge 'token_rejected'
        }
        if ($response.Code -ge 300 -and $response.Code -lt 500 -and $response.Code -notin @(408, 429)) {
            Stop-Bridge 'bridge_result_rejected'
        }
        Update-BridgePrinter
        if (!$retrying) {
            Write-BridgeLog 'bridge_result_unreachable'
            Update-BridgeTelemetry 'bridge_result_unreachable'
            $retrying = $true
        }
        Wait-BridgeRetry $pause
        $pause = [Math]::Min(30, $pause * 2)
    }
}

if ($DryRun) {
    New-TicketRows (New-DemoTicket $Scenario) | ForEach-Object {
        if ($_ -eq '[linea]') { return ('-' * 32) }
        $line = $_ -replace '^\^?!?', ''
        if ($_.StartsWith('^')) {
            $inset = [Math]::Max(0, [Math]::Floor((32 - $line.Length) / 2))
            return (' ' * [int]$inset + $line)
        }
        $line
    }
    return
}
$telemetry = $null
$mutex = $null
$hasLock = $false
try {
    if ($env:OS -ne 'Windows_NT' -or $PSVersionTable.PSEdition -ne 'Desktop') { Stop-Bridge 'windows_required' }
    if ($ListPrinters) {
        try {
            Add-Type -AssemblyName System.Drawing
            $names = @([Drawing.Printing.PrinterSettings]::InstalledPrinters | Sort-Object)
        } catch { Stop-Bridge 'printer_list_error' }
        if (!$names.Count) { Write-BridgeLog 'printer_list_empty' }
        $names
        return
    }
    if (!$ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'printer.config.json' }
    if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { Stop-Bridge 'config_missing' }
    try { $config = Get-BridgeConfig $ConfigPath }
    catch { Stop-Bridge 'config_invalid' }

    try {
        $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Print-GdiTicket.cs') -Raw -Encoding UTF8
        Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Drawing.dll'
    } catch { Stop-Bridge 'driver_load_error' }
    if ($TestPrint) {
        try {
            [PuntoCero.TicketPrinter]::Check($config.Printer)
            [PuntoCero.TicketPrinter]::Print($config.Printer, 'Punto Cero - Prueba local', (New-TicketRows (New-DemoTicket $Scenario)))
        } catch { Stop-Bridge 'printer_test_failed' }
        Write-BridgeLog 'printer_test_sent'
        return
    }

    try { $credential = Get-PrinterCredential }
    catch { Stop-Bridge 'token_unreadable' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $mutex = [Threading.Mutex]::new($false, 'Local\PuntoCeroComandas')
    try { $hasLock = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $hasLock = $true }
    if (!$hasLock) { Stop-Bridge 'bridge_already_running' }
    Write-BridgeLog 'bridge_started'
    $telemetry = New-BridgeTelemetry
    $printer = @{ State = '' }
    $claimUnreachable = $false
    $pause = $config.Poll
    while ($true) {
        Update-BridgePrinter
        if ($printer.State -ne 'ready') {
            Wait-BridgeRetry $config.Poll
            continue
        }

        $response = Invoke-BridgeApi '/api/impresora/claim' @{}
        if ($response.Code -eq 401 -or $response.Code -eq 403) {
            Stop-Bridge 'token_rejected'
        }
        if ($response.Code -ge 300 -and $response.Code -lt 500 -and $response.Code -notin @(408, 429)) {
            Stop-Bridge 'bridge_claim_rejected'
        }
        if ($response.Code -ne 200 -or -not $response.Data -or -not $response.Data.PSObject.Properties['job']) {
            if (!$claimUnreachable) {
                Write-BridgeLog 'bridge_claim_unreachable'
                Update-BridgeTelemetry 'bridge_claim_unreachable'
                $claimUnreachable = $true
            }
            Wait-BridgeRetry $pause
            $pause = [Math]::Min(60, $pause * 2)
            continue
        }
        if ($claimUnreachable) { Write-BridgeLog 'bridge_claim_recovered' }
        $claimUnreachable = $false
        $pause = $config.Poll
        $job = $response.Data.job
        if (-not $job) {
            Wait-BridgeRetry $config.Poll
            continue
        }

        $result = @{ id = $job.id; claimToken = $job.claimToken }
        $rows = $null
        try {
            $rows = New-TicketRows $job
        } catch {
            $result.status = 'failed'
            $result.error = 'No se pudo preparar el ticket. La cola de Windows no recibió este intento.'
            Write-BridgeLog 'bridge_ticket_invalid'
        }
        if ($null -ne $rows) {
            try {
                $title = 'Punto Cero - Comanda {0}' -f $job.number
                if ($job.isCopy) { $title += ' (copia)' }
                [PuntoCero.TicketPrinter]::Print($config.Printer, $title, $rows)
                $result.status = 'sent'
            } catch {
                $result.status = 'uncertain'
                $result.error = 'Windows devolvió un error durante el envío. Comprueba la cola y el papel.'
                Write-BridgeLog 'bridge_print_uncertain'
            }
        }
        if ((Confirm-PrintResult $result) -and $result.status -eq 'sent') {
            Write-BridgeLog 'bridge_print_confirmed'
        }
    }
} catch {
    Stop-Bridge 'bridge_internal_error'
} finally {
    if ($null -ne $telemetry) {
        $telemetry.Client.Dispose()
        if ($null -ne $telemetry.InFlight) { $telemetry.InFlight.Request.Dispose() }
    }
    if ($hasLock) {
        $mutex.ReleaseMutex()
        Write-BridgeLog 'bridge_stopped'
    }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
