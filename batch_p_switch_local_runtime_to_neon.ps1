[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$EnvPath = Join-Path $ProjectRoot ".env"
$SupervisorPath = Join-Path $ProjectRoot "run_all_channels.py"
$SignatureTables = @(
    "clients",
    "channel_accounts",
    "channel_contacts",
    "customers",
    "conversations",
    "messages",
    "message_reply_jobs",
    "connector_nodes",
    "ai_agents",
    "client_trial_entitlements",
    "platform_users",
    "user_password_credentials",
    "client_memberships",
    "platform_user_sessions",
    "platform_refresh_token_history"
)
$PgEnvironmentNames = @(
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGSSLMODE",
    "PGCONNECT_TIMEOUT"
)

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-PgToolchain {
    $command = Get-Command "psql" -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $psqlPath = $null

    if ($null -ne $command) {
        $psqlPath = $command.Source
    }

    if (-not $psqlPath) {
        $searchRoot = Join-Path ${env:ProgramFiles} "PostgreSQL"

        if (Test-Path -LiteralPath $searchRoot -PathType Container) {
            $candidates = Get-ChildItem `
                -Path (Join-Path $searchRoot "*\bin\psql.exe") `
                -File `
                -ErrorAction SilentlyContinue

            if ($candidates) {
                $psqlPath = (
                    $candidates |
                    Sort-Object -Property FullName -Descending |
                    Select-Object -First 1
                ).FullName
            }
        }
    }

    if (-not $psqlPath) {
        throw (
            "psql was not found. Install PostgreSQL command-line tools or " +
            "add the PostgreSQL bin folder to PATH."
        )
    }

    return $psqlPath
}

function Resolve-ProjectPython {
    $candidates = @(
        (Join-Path $ProjectRoot "venv\Scripts\python.exe"),
        (Join-Path $ProjectRoot ".venv\Scripts\python.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    $command = Get-Command "python" -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($null -eq $command) {
        throw "Project Python was not found."
    }

    return $command.Source
}

function Set-PgEnvironment {
    param([hashtable]$Configuration)

    $env:PGHOST = [string]$Configuration.Host
    $env:PGPORT = [string]$Configuration.Port
    $env:PGDATABASE = [string]$Configuration.Database
    $env:PGUSER = [string]$Configuration.User
    $env:PGPASSWORD = [string]$Configuration.Password
    $env:PGSSLMODE = "require"
    $env:PGCONNECT_TIMEOUT = "15"
}

function Invoke-PsqlScalar {
    param(
        [string]$PsqlPath,
        [string]$Sql,
        [string]$FailureMessage
    )

    $output = & $PsqlPath `
        --no-psqlrc `
        --quiet `
        --tuples-only `
        --no-align `
        --set ON_ERROR_STOP=1 `
        --command $Sql 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }

    $lines = @(
        $output |
        ForEach-Object { [string]$_ } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
    )

    if ($lines.Count -eq 0) {
        return ""
    }

    return $lines[-1]
}

function Assert-PsqlTlsConnection {
    param([string]$PsqlPath)

    # Neon terminates client TLS at its managed proxy, so backend pg_stat_ssl
    # can report no backend TLS row even when the client-to-Neon connection is
    # encrypted. PGSSLMODE=require makes libpq refuse a plaintext connection;
    # psql's client-side \conninfo output then supplies the transport proof.
    $connectionInfo = & $PsqlPath `
        --no-psqlrc `
        --command "\conninfo" 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Could not establish the required-TLS Neon connection."
    }

    $connectionText = (
        $connectionInfo |
        ForEach-Object { [string]$_ }
    ) -join "`n"

    if ($connectionText -notmatch "(?i)(SSL connection|TLSv1\.[0-9])") {
        throw "psql did not confirm an SSL/TLS connection to Neon."
    }

    return $true
}

function ConvertFrom-NeonConnectionString {
    param([string]$ConnectionString)

    $raw = ([string]$ConnectionString).Trim()
    if (-not $raw) {
        throw "The Neon connection string was empty."
    }

    if (
        ($raw.StartsWith("'") -and $raw.EndsWith("'")) -or
        ($raw.StartsWith('"') -and $raw.EndsWith('"'))
    ) {
        $raw = $raw.Substring(1, $raw.Length - 2).Trim()
    }

    try {
        $uri = [System.Uri]$raw
    }
    catch {
        throw "The Neon connection string is not a valid PostgreSQL URL."
    }

    if ($uri.Scheme -notin @("postgres", "postgresql")) {
        throw "Use a Neon URL beginning with postgresql:// or postgres://."
    }

    if (-not $uri.Host -or $uri.Host -in @("localhost", "127.0.0.1", "::1")) {
        throw "The database host must be a remote Neon host."
    }

    $userInfo = [string]$uri.UserInfo
    $separator = $userInfo.IndexOf(":")

    if ($separator -le 0) {
        throw "The Neon URL does not contain both user and password."
    }

    $user = [System.Uri]::UnescapeDataString(
        $userInfo.Substring(0, $separator)
    )
    $password = [System.Uri]::UnescapeDataString(
        $userInfo.Substring($separator + 1)
    )
    $database = [System.Uri]::UnescapeDataString(
        $uri.AbsolutePath.TrimStart("/")
    )
    $port = if ($uri.IsDefaultPort -or $uri.Port -le 0) {
        "5432"
    }
    else {
        [string]$uri.Port
    }

    if (-not $user -or -not $password -or -not $database) {
        throw "The Neon URL is missing user, password, or database name."
    }

    foreach ($value in @($uri.Host, $port, $database, $user, $password)) {
        if ([string]$value -match "[\r\n\x00]") {
            throw "The Neon URL contains an unsafe control character."
        }
    }

    return @{
        Host = $uri.Host
        Port = $port
        Database = $database
        User = $user
        Password = $password
    }
}

function Get-SignatureSql {
    $parts = foreach ($table in $SignatureTables) {
        "(SELECT COUNT(*)::text FROM public.$table)"
    }

    return "SELECT concat_ws('|', " + ($parts -join ", ") + ");"
}

function Get-StringSha256 {
    param([string]$Value)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return -join (
            $sha.ComputeHash($bytes) |
            ForEach-Object { $_.ToString("x2") }
        )
    }
    finally {
        $sha.Dispose()
    }
}

function ConvertTo-DotEnvValue {
    param([string]$Value)

    if ($Value -match "[\r\n\x00]") {
        throw "A database setting contains an unsafe control character."
    }

    $escaped = $Value.Replace("\", "\\").Replace("'", "\'")
    return "'$escaped'"
}

function Update-DotEnvText {
    param(
        [string]$OriginalText,
        [hashtable]$Values
    )

    $normalized = $OriginalText.Replace("`r`n", "`n").Replace("`r", "`n")
    $lines = [System.Collections.Generic.List[string]]::new()

    foreach ($line in $normalized.Split("`n")) {
        [void]$lines.Add($line)
    }

    foreach ($key in $Values.Keys) {
        $replacement = "$key=$(ConvertTo-DotEnvValue -Value ([string]$Values[$key]))"
        $found = $false

        for ($index = 0; $index -lt $lines.Count; $index += 1) {
            if ($lines[$index] -match "^\s*$([regex]::Escape($key))\s*=") {
                $lines[$index] = $replacement
                $found = $true
                break
            }
        }

        if (-not $found) {
            [void]$lines.Add($replacement)
        }
    }

    return ($lines -join "`r`n").TrimEnd("`r", "`n") + "`r`n"
}

function Write-Utf8WithoutBom {
    param(
        [string]$Path,
        [string]$Text
    )

    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

$originalPgEnvironment = @{}
foreach ($name in $PgEnvironmentNames) {
    $originalPgEnvironment[$name] = [Environment]::GetEnvironmentVariable(
        $name,
        "Process"
    )
}

$originalEnvBytes = $null
$envWasUpdated = $false
$neonConfiguration = $null
$secureConnectionString = $null
$plainConnectionString = $null
$temporaryEnvPath = Join-Path $ProjectRoot ".env.neon-switching"

try {
    Write-Host ""
    Write-Host "OmniFlow Batch P v2 - Switch Local Runtime to Neon" -ForegroundColor Green
    Write-Host "No browser, channel worker, or bot will be started."

    Write-Step "Locating the verified Batch O migration report"
    if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
        throw "The project .env file was not found beside Batch P."
    }

    if (-not (Test-Path -LiteralPath $SupervisorPath -PathType Leaf)) {
        throw "run_all_channels.py was not found beside Batch P."
    }

    $backupRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) `
        "OmniFlow-Backups"
    $reportFile = Get-ChildItem `
        -LiteralPath $backupRoot `
        -Filter "omniflow-neon-migration-*.json" `
        -File `
        -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTimeUtc -Descending |
        Select-Object -First 1

    if ($null -eq $reportFile) {
        throw "A verified Batch O migration report was not found."
    }

    try {
        $migrationReport = Get-Content `
            -LiteralPath $reportFile.FullName `
            -Raw `
            -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        throw "The Batch O migration report is not valid JSON."
    }

    if (
        [string]$migrationReport.status -ne "verified" -or
        [bool]$migrationReport.migrations_reapplied -ne $false -or
        [bool]$migrationReport.local_env_changed -ne $false -or
        [string]$migrationReport.tenant_invariants -ne "PASSED"
    ) {
        throw "The latest Batch O report is not a verified migration result."
    }

    $backupPath = [string]$migrationReport.backup_file
    if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        throw "The PostgreSQL backup referenced by Batch O is missing."
    }

    $actualBackupHash = (Get-FileHash `
        -LiteralPath $backupPath `
        -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualBackupHash -cne [string]$migrationReport.backup_sha256) {
        throw "The Batch O PostgreSQL backup checksum does not match its report."
    }

    Write-Host "Batch O report: verified"
    Write-Host "Batch O backup checksum: verified"

    Write-Step "Reading the same Neon Direct connection securely"
    Write-Host "Paste the same raw postgresql:// Direct URL used for Batch O."
    Write-Host "Input is masked and is never printed."
    $secureConnectionString = Read-Host `
        "Neon Direct connection string" `
        -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
        $secureConnectionString
    )

    try {
        $plainConnectionString = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            $bstr
        )
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }

    $neonConfiguration = ConvertFrom-NeonConnectionString `
        -ConnectionString $plainConnectionString
    $plainConnectionString = $null

    if (
        [string]$migrationReport.destination_database -cne
        [string]$neonConfiguration.Database
    ) {
        throw "This Neon database name does not match the verified Batch O report."
    }

    Write-Step "Revalidating Neon schema, data, SSL, and tenant boundaries"
    $psqlPath = Resolve-PgToolchain
    Set-PgEnvironment -Configuration $neonConfiguration

    $tlsConfirmed = Assert-PsqlTlsConnection -PsqlPath $psqlPath
    if (-not $tlsConfirmed) {
        throw "The required-TLS Neon connection was not confirmed."
    }

    $signature = Invoke-PsqlScalar `
        -PsqlPath $psqlPath `
        -Sql (Get-SignatureSql) `
        -FailureMessage "Could not calculate the Neon data signature."
    $signatureHash = Get-StringSha256 -Value $signature

    if (
        $signatureHash -cne
        [string]$migrationReport.verification_signature_sha256
    ) {
        throw "Neon data no longer matches the verified Batch O migration signature."
    }

    $tenantInvariant = Invoke-PsqlScalar `
        -PsqlPath $psqlPath `
        -Sql @"
SELECT CASE
    WHEN EXISTS (
        SELECT 1
        FROM public.channel_accounts account
        LEFT JOIN public.clients client ON client.id = account.client_id
        WHERE client.id IS NULL
    ) THEN 'FAILED'
    WHEN EXISTS (
        SELECT 1
        FROM public.client_memberships membership
        LEFT JOIN public.clients client ON client.id = membership.client_id
        LEFT JOIN public.platform_users platform_user
          ON platform_user.id = membership.user_id
        WHERE client.id IS NULL OR platform_user.id IS NULL
    ) THEN 'FAILED'
    WHEN EXISTS (
        SELECT 1
        FROM public.platform_refresh_token_history history
        LEFT JOIN public.platform_user_sessions session
          ON session.id = history.session_id
         AND session.user_id = history.user_id
         AND session.client_id = history.client_id
        WHERE session.id IS NULL
    ) THEN 'FAILED'
    ELSE 'PASSED'
END;
"@ `
        -FailureMessage "Could not verify Neon tenant/authentication invariants."

    if ($tenantInvariant -ne "PASSED") {
        throw "Neon tenant/authentication invariants failed."
    }

    Write-Host "Neon SSL: verified"
    Write-Host "Neon data signature: verified"
    Write-Host "Neon tenant/authentication invariants: verified"

    Write-Step "Creating an encrypted rollback copy of the current .env"
    $originalEnvBytes = [System.IO.File]::ReadAllBytes($EnvPath)
    $originalEnvBase64 = [Convert]::ToBase64String($originalEnvBytes)
    $originalEnvSecure = ConvertTo-SecureString `
        -String $originalEnvBase64 `
        -AsPlainText `
        -Force
    try {
        $encryptedRollback = ConvertFrom-SecureString $originalEnvSecure
    }
    finally {
        $originalEnvSecure.Dispose()
        $originalEnvBase64 = $null
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $rollbackPath = Join-Path $backupRoot `
        "omniflow-env-before-neon-$timestamp.dpapi.txt"
    Set-Content `
        -LiteralPath $rollbackPath `
        -Value $encryptedRollback `
        -Encoding ASCII
    $encryptedRollback = $null
    Write-Host "Encrypted rollback file created (Windows user protected)."

    Write-Step "Updating only the local database settings"
    $originalText = [System.Text.Encoding]::UTF8.GetString($originalEnvBytes)
    $newText = Update-DotEnvText `
        -OriginalText $originalText `
        -Values @{
            DB_HOST = $neonConfiguration.Host
            DB_PORT = $neonConfiguration.Port
            DB_NAME = $neonConfiguration.Database
            DB_USER = $neonConfiguration.User
            DB_PASSWORD = $neonConfiguration.Password
            DB_SSLMODE = "require"
            PGSSLMODE = "require"
        }

    Write-Utf8WithoutBom -Path $temporaryEnvPath -Text $newText
    Move-Item `
        -LiteralPath $temporaryEnvPath `
        -Destination $EnvPath `
        -Force
    $envWasUpdated = $true
    $originalText = $null
    $newText = $null

    Write-Step "Running the real application database-only launch check"
    $pythonPath = Resolve-ProjectPython
    $checkOutput = & $pythonPath `
        $SupervisorPath `
        --check `
        --only-account 1 2>&1
    $checkExitCode = $LASTEXITCODE

    foreach ($line in $checkOutput) {
        Write-Host ([string]$line)
    }

    if ($checkExitCode -ne 0) {
        throw "The real application could not load and query Neon through .env."
    }

    $checkText = ($checkOutput | ForEach-Object { [string]$_ }) -join "`n"
    if (
        $checkText -notmatch "CHECK ONLY" -or
        $checkText -notmatch "account 1" -or
        $checkText -notmatch "action=ready"
    ) {
        throw (
            "The application check did not confirm Account 1 as ready without " +
            "starting workers."
        )
    }

    $switchReportPath = Join-Path $backupRoot `
        "omniflow-local-neon-switch-$timestamp.json"
    [ordered]@{
        status = "verified"
        completed_at_utc = (Get-Date).ToUniversalTime().ToString("o")
        batch_o_report = $reportFile.FullName
        encrypted_env_rollback = $rollbackPath
        neon_database = $neonConfiguration.Database
        neon_ssl = "required_and_verified"
        verification_signature_sha256 = $signatureHash
        tenant_invariants = $tenantInvariant
        account_1_check = "ready"
        browsers_started = $false
        workers_started = $false
        migrations_reapplied = $false
    } |
        ConvertTo-Json -Depth 4 |
        Set-Content `
            -LiteralPath $switchReportPath `
            -Encoding UTF8

    Write-Host ""
    Write-Host "BATCH P PASSED" -ForegroundColor Green
    Write-Host "Verified Batch O migration: PASSED"
    Write-Host "Neon SSL and data signature: PASSED"
    Write-Host "Tenant/authentication invariants: PASSED"
    Write-Host "Local .env database switch: PASSED"
    Write-Host "Real application check for Account 1: PASSED"
    Write-Host "Browsers/workers started: NO"
    Write-Host "Migrations 001-006 reapplied: NO"
    Write-Host "Report: $switchReportPath"
    Write-Host ""
    Write-Host "Do not start the bot yet; send only: BATCH P PASSED"
}
catch {
    if ($envWasUpdated -and $null -ne $originalEnvBytes) {
        try {
            [System.IO.File]::WriteAllBytes($EnvPath, $originalEnvBytes)
            $envWasUpdated = $false
            Write-Host "Original .env restored automatically." -ForegroundColor Yellow
        }
        catch {
            Write-Host (
                "CRITICAL: automatic .env rollback failed. Keep the bot stopped " +
                "and use the encrypted rollback file."
            ) -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "BATCH P STOPPED SAFELY" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "No browser or channel worker was intentionally started."
    Write-Host "Do not manually run migrations 001-006."
    exit 1
}
finally {
    $plainConnectionString = $null

    if (Test-Path -LiteralPath $temporaryEnvPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryEnvPath -Force -ErrorAction SilentlyContinue
    }

    if ($null -ne $secureConnectionString) {
        $secureConnectionString.Dispose()
    }

    if ($null -ne $neonConfiguration) {
        $neonConfiguration.Password = $null
    }

    if ($null -ne $originalEnvBytes) {
        [Array]::Clear($originalEnvBytes, 0, $originalEnvBytes.Length)
    }

    foreach ($name in $PgEnvironmentNames) {
        $originalValue = $originalPgEnvironment[$name]

        if ($null -eq $originalValue) {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
        else {
            [Environment]::SetEnvironmentVariable(
                $name,
                [string]$originalValue,
                "Process"
            )
        }
    }
}
