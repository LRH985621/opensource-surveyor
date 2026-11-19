#requires -Version 5.1
[CmdletBinding()]
param([switch]$Preview, [switch]$Download)

$ErrorActionPreference = 'Stop'
$taskName = 'OpenSourceSurveyor-Weekly'
$scriptPath = Join-Path $PSScriptRoot 'weekly-surveyor.mjs'
$nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$arguments = '--use-env-proxy "' + $scriptPath + '" --notify'
if ($Download) { $arguments += ' --download' }

$nodeVersion = [version]((& $nodePath --version).TrimStart('v'))
if ($nodeVersion -lt [version]'24.5.0') { throw 'Node.js 24.5.0 or newer is required.' }

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw 'weekly-surveyor.mjs was not found alongside this script.'
}

$definition = [PSCustomObject]@{
    TaskName = $taskName
    User = $identity.Name
    Trigger = 'Monday at 09:00 Windows local time'
    Execute = $nodePath
    Arguments = $arguments
    WorkingDirectory = $PSScriptRoot
    StartWhenAvailable = $true
    RunLevel = 'Limited'
}
if ($Preview) {
    $definition | Format-List
    return
}
$taskExists = Get-ScheduledTask | Where-Object { $_.TaskName -eq $taskName -and $_.TaskPath -eq '\' }
if ($taskExists) { throw "Task already exists; no changes made: $taskName" }

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At ([datetime]::Today.AddHours(9))
$principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Weekly public GitHub project survey, local report, and pinned source archives. No third-party code execution.' | Out-Null

$task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
$info = Get-ScheduledTaskInfo -InputObject $task
[PSCustomObject]@{
    TaskName = $task.TaskName
    State = $task.State
    User = $task.Principal.UserId
    Execute = $task.Actions.Execute
    Arguments = $task.Actions.Arguments
    NextRunTime = $info.NextRunTime
} | Format-List
