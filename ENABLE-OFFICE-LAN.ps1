param([ValidateRange(1024,65535)][int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from PowerShell as administrator. It adds one inbound TCP rule for the private office network and LocalSubnet only.'
}
$name = 'CodexChatBridge.Office.TCP.' + $Port
$existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($existing) {
    $filter = $existing | Get-NetFirewallPortFilter
    $scope = $existing | Get-NetFirewallAddressFilter
    if ($existing.Direction -ne 'Inbound' -or $existing.Action -ne 'Allow' -or $existing.Profile.ToString() -ne 'Private' -or $filter.LocalPort -ne $Port.ToString() -or $filter.Protocol -notin @('TCP','6') -or $scope.RemoteAddress -notcontains 'LocalSubnet') {
        throw 'A different firewall rule already uses this name. It was left unchanged.'
    }
    if ($existing.Enabled -ne 'True') { Enable-NetFirewallRule -Name $name | Out-Null }
} else {
    New-NetFirewallRule -Name $name -DisplayName ('Codex Chat Bridge - office TCP ' + $Port) -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
}
Get-NetFirewallRule -Name $name | Select-Object DisplayName,Enabled,Profile,Direction,Action
Get-NetFirewallRule -Name $name | Get-NetFirewallPortFilter | Select-Object Protocol,LocalPort
Get-NetFirewallRule -Name $name | Get-NetFirewallAddressFilter | Select-Object RemoteAddress
