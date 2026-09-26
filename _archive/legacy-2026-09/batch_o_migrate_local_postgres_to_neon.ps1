[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$EnvPath = Join-Path $ProjectRoot ".env"
$RequiredLocalTables = @(
    "clients",
    "channel_accounts",
    "channel_contacts",
    "customers",
    "conversations",
    "messages",
    "message_reply_jobs",
    "channel_account_leases",
    "connector_nodes",
    "ai_agents",
    "client_trial_entitlements",
    "platform_users",
    "user_password_credentials",
    "client_memberships",
    "platform_user_sessions",
    "platform_refresh_token_history"
)
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

function Read-DotEnvFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Local .env file was not found beside this script: $Path"
    }

    $values = @{}

    foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
        $line = $rawLine.Trim()

        if (-not $line -or $line.StartsWith("#")) {
            continue
        }

        $separator = $line.IndexOf("=")
        if ($separator -le 0) {
            continue
        }

        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()

        if (
            $value.Length -ge 2 -and
            (
                ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))
            )
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        if ($key) {
            $values[$key] = $value
        }
    }

    return $values
}

function Resolve-PgToolchain {
    $command = Get-Command "pg_dump" -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $pgDumpPath = $null

    if ($null -ne $command) {
        $pgDumpPath = $command.Source
    }

    if (-not $pgDumpPath) {
        $searchRoot = Join-Path ${env:ProgramFiles} "PostgreSQL"

        if (Test-Path -LiteralPath $searchRoot -PathType Container) {
            $candidates = Get-ChildItem `
                -Path (Join-Path $searchRoot "*\bin\pg_dump.exe") `
                -File `
                -ErrorAction SilentlyContinue

            if ($candidates) {
                $pgDumpPath = (
                    $candidates |
                    Sort-Object -Property FullName -Descending |
                    Select-Object -First 1
                ).FullName
            }
        }
    }

    if (-not $pgDumpPath) {
        throw (
            "pg_dump was not found. Install PostgreSQL command-line tools " +
            "or add the PostgreSQL bin folder to PATH, then run this script again."
        )
    }

    $binDirectory = Split-Path -Parent $pgDumpPath
    $psqlPath = Join-Path $binDirectory "psql.exe"
    $pgRestorePath = Join-Path $binDirectory "pg_restore.exe"

    if (-not (Test-Path -LiteralPath $psqlPath -PathType Leaf)) {
        throw "psql.exe was not found beside pg_dump.exe: $binDirectory"
    }

    if (-not (Test-Path -LiteralPath $pgRestorePath -PathType Leaf)) {
        throw "pg_restore.exe was not found beside pg_dump.exe: $binDirectory"
    }

    return [pscustomobject]@{
        PgDump = $pgDumpPath
        PgRestore = $pgRestorePath
        Psql = $psqlPath
    }
}

function Set-PgEnvironment {
    param(
        [hashtable]$Configuration,
        [string]$SslMode
    )

    $env:PGHOST = [string]$Configuration.Host
    $env:PGPORT = [string]$Configuration.Port
    $env:PGDATABASE = [string]$Configuration.Database
    $env:PGUSER = [string]$Configuration.User
    $env:PGPASSWORD = [string]$Configuration.Password
    $env:PGSSLMODE = $SslMode
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

function ConvertFrom-NeonConnectionString {
    param([string]$ConnectionString)

    $raw = [string]$ConnectionString
    if (-not $raw) {
        throw "The Neon connection string was empty."
    }

    try {
        $uri = [System.Uri]$raw
    }
    catch {
        throw "The Neon connection string is not a valid PostgreSQL URL."
    }

    if ($uri.Scheme -notin @("postgres", "postgresql")) {
        throw "Use a Neon PostgreSQL URL beginning with postgresql:// or postgres://."
    }

    if (-not $uri.Host) {
        throw "The Neon connection string does not contain a database host."
    }

    if ($uri.Host -in @("localhost", "127.0.0.1", "::1")) {
        throw "The destination must be Neon, not the local PostgreSQL server."
    }

    $userInfo = [string]$uri.UserInfo
    $separator = $userInfo.IndexOf(":")

    if ($separator -le 0) {
        throw "The Neon connection string does not contain both user and password."
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
        throw "The Neon connection string is missing user, password, or database name."
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
    param([string[]]$Tables)

    $parts = foreach ($table in $Tables) {
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

$originalPgEnvironment = @{}
foreach ($name in $PgEnvironmentNames) {
    $originalPgEnvironment[$name] = [Environment]::GetEnvironmentVariable(
        $name,
        "Process"
    )
}

$neonConfiguration = $null
$localConfiguration = $null
$secureConnectionString = $null
$plainConnectionString = $null

try {
    Write-Host ""
    Write-Host "OmniFlow Batch O v2 - Local PostgreSQL to Neon" -ForegroundColor Green
    Write-Host "This process does NOT reapply migrations 001-006."
    Write-Host "It copies the already-tested local schema and data as one verified backup."

    Write-Step "Loading local database configuration"
    $dotenv = Read-DotEnvFile -Path $EnvPath
    $requiredKeys = @("DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD")
    $missingKeys = @(
        $requiredKeys |
        Where-Object {
            -not $dotenv.ContainsKey($_) -or
            -not [string]$dotenv[$_]
        }
    )

    if ($missingKeys.Count -gt 0) {
        throw "Missing local .env values: $($missingKeys -join ', ')"
    }

    $localConfiguration = @{
        Host = [string]$dotenv.DB_HOST
        Port = [string]$dotenv.DB_PORT
        Database = [string]$dotenv.DB_NAME
        User = [string]$dotenv.DB_USER
        Password = [string]$dotenv.DB_PASSWORD
    }
    $localSslMode = if (
        $dotenv.ContainsKey("DB_SSLMODE") -and
        [string]$dotenv.DB_SSLMODE
    ) {
        [string]$dotenv.DB_SSLMODE
    }
    else {
        "prefer"
    }

    $tools = Resolve-PgToolchain
    $toolVersion = & $tools.PgDump --version
    if ($LASTEXITCODE -ne 0) {
        throw "The PostgreSQL command-line tools could not be started."
    }
    Write-Host "PostgreSQL tools: $toolVersion"

    Write-Step "Verifying the local source database"
    Set-PgEnvironment -Configuration $localConfiguration -SslMode $localSslMode

    $requiredTableSqlList = (
        $RequiredLocalTables |
        ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    ) -join ","
    $sourceReadinessSql = @"
SELECT CASE
    WHEN COUNT(*) = $($RequiredLocalTables.Count) THEN 'READY'
    ELSE 'MISSING'
END
FROM pg_catalog.pg_tables
WHERE schemaname = 'public'
  AND tablename IN ($requiredTableSqlList);
"@
    $sourceReadiness = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql $sourceReadinessSql `
        -FailureMessage "Could not connect to the local PostgreSQL database."

    if ($sourceReadiness -ne "READY") {
        throw (
            "The local database is missing one or more required OmniFlow tables. " +
            "No backup or destination change was made."
        )
    }

    $liveLeaseCount = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql @"
SELECT COUNT(*)
FROM public.channel_account_leases
WHERE owner_token IS NOT NULL
  AND lease_expires_at > CURRENT_TIMESTAMP;
"@ `
        -FailureMessage "Could not verify local channel-account leases."

    if ([long]$liveLeaseCount -gt 0) {
        throw (
            "A channel worker still owns a live database lease. Stop the bot, " +
            "wait about 2 minutes, and run Batch O again."
        )
    }

    $sourceDatabaseBytes = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql "SELECT pg_database_size(current_database());" `
        -FailureMessage "Could not determine the local database size."
    $sourceDatabaseMiB = [math]::Round(([double]$sourceDatabaseBytes / 1MB), 2)

    if ([double]$sourceDatabaseBytes -gt 450MB) {
        throw (
            "The local database is $sourceDatabaseMiB MiB, which is too close " +
            "to Neon's free storage limit for a safe migration."
        )
    }

    $signatureSql = Get-SignatureSql -Tables $SignatureTables
    $sourceSignature = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql $signatureSql `
        -FailureMessage "Could not calculate the local verification signature."
    $sourceSignatureHash = Get-StringSha256 -Value $sourceSignature

    Write-Host "Local database: verified"
    Write-Host "Local database size: $sourceDatabaseMiB MiB"

    Write-Step "Reading the Neon Direct connection string securely"
    Write-Host "In Neon: Connect -> Connection string -> Direct connection (not pooled)."
    Write-Host "Paste it below. Input is masked and will not be written to a file."
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

    Write-Step "Verifying the empty Neon destination"
    Set-PgEnvironment -Configuration $neonConfiguration -SslMode "require"

    $destinationVersion = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql "SELECT current_setting('server_version');" `
        -FailureMessage (
            "Could not connect to Neon. Use the Direct connection string and " +
            "confirm that the Neon project is active."
        )

    $destinationTableCount = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql @"
SELECT COUNT(*)
FROM pg_catalog.pg_tables
WHERE schemaname = 'public'
  AND tablename IN ($requiredTableSqlList);
"@ `
        -FailureMessage "Could not inspect the Neon public schema."

    if ([long]$destinationTableCount -ne 0) {
        throw (
            "Neon already contains OmniFlow application tables. Batch O refuses " +
            "to overwrite or merge them. Use a new empty Neon project/branch."
        )
    }

    Write-Host "Neon PostgreSQL: $destinationVersion"
    Write-Host "Neon destination: empty and ready"

    Write-Step "Creating a consistent local backup"
    $backupRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) `
        "OmniFlow-Backups"
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = Join-Path $backupRoot `
        "omniflow-before-neon-$timestamp.dump"

    Set-PgEnvironment -Configuration $localConfiguration -SslMode $localSslMode
    & $tools.PgDump `
        --format=custom `
        --compress=6 `
        --no-owner `
        --no-privileges `
        --schema=public `
        --file=$backupPath

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backupPath)) {
        throw "Local PostgreSQL backup failed. Neon was not changed."
    }

    $backupItem = Get-Item -LiteralPath $backupPath
    if ($backupItem.Length -le 0) {
        throw "The generated PostgreSQL backup is empty. Neon was not changed."
    }

    $backupSha256 = (Get-FileHash `
        -LiteralPath $backupPath `
        -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Backup created: $backupPath"
    Write-Host "Backup SHA-256: $backupSha256"

    Write-Step "Restoring the verified backup into Neon"
    Set-PgEnvironment -Configuration $neonConfiguration -SslMode "require"
    & $tools.PgRestore `
        --dbname=$($neonConfiguration.Database) `
        --clean `
        --if-exists `
        --exit-on-error `
        --single-transaction `
        --no-owner `
        --no-privileges `
        $backupPath

    if ($LASTEXITCODE -ne 0) {
        throw (
            "Neon restore failed and the single transaction was rolled back. " +
            "Keep the backup file and do not change the local .env."
        )
    }

    Write-Step "Comparing source and destination"
    $destinationReadiness = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql $sourceReadinessSql `
        -FailureMessage "Could not verify required tables after the Neon restore."

    if ($destinationReadiness -ne "READY") {
        throw "Neon restore finished but required OmniFlow tables are missing."
    }

    $destinationSignature = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
        -Sql $signatureSql `
        -FailureMessage "Could not calculate the Neon verification signature."
    $destinationSignatureHash = Get-StringSha256 -Value $destinationSignature

    if ($destinationSignature -cne $sourceSignature) {
        throw (
            "Source and Neon record-count signatures do not match. The local " +
            "database remains unchanged; do not switch the application yet."
        )
    }

    $tenantInvariant = Invoke-PsqlScalar `
        -PsqlPath $tools.Psql `
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
        -FailureMessage "Could not verify tenant/authentication invariants on Neon."

    if ($tenantInvariant -ne "PASSED") {
        throw "Neon tenant/authentication invariant verification failed."
    }

    $reportPath = Join-Path $backupRoot `
        "omniflow-neon-migration-$timestamp.json"
    $report = [ordered]@{
        status = "verified"
        completed_at_utc = (Get-Date).ToUniversalTime().ToString("o")
        source_database = $localConfiguration.Database
        destination_database = $neonConfiguration.Database
        source_database_mib = $sourceDatabaseMiB
        backup_file = $backupPath
        backup_sha256 = $backupSha256
        verification_signature_sha256 = $sourceSignatureHash
        tenant_invariants = $tenantInvariant
        local_env_changed = $false
        migrations_reapplied = $false
    }
    $report |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath $reportPath -Encoding UTF8

    Write-Host ""
    Write-Host "BATCH O PASSED" -ForegroundColor Green
    Write-Host "Local PostgreSQL backup: PASSED"
    Write-Host "Neon restore: PASSED"
    Write-Host "Required table verification: PASSED"
    Write-Host "Source/destination signature: PASSED"
    Write-Host "Tenant/authentication invariants: PASSED"
    Write-Host "Migrations 001-006 reapplied: NO"
    Write-Host "Local .env changed: NO"
    Write-Host "Report: $reportPath"
    Write-Host ""
    Write-Host "Keep this PowerShell window open and send only: BATCH O PASSED"
}
catch {
    Write-Host ""
    Write-Host "BATCH O STOPPED SAFELY" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "Local .env was not changed."
    Write-Host "Do not manually run migrations 001-006."
    exit 1
}
finally {
    $plainConnectionString = $null

    if ($null -ne $secureConnectionString) {
        $secureConnectionString.Dispose()
    }

    if ($null -ne $neonConfiguration) {
        $neonConfiguration.Password = $null
    }

    if ($null -ne $localConfiguration) {
        $localConfiguration.Password = $null
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
