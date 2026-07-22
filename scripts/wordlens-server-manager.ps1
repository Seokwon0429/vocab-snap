[CmdletBinding()]
param(
  [switch] $SkipElevation,
  [string] $RenderPreviewPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$taskName = 'WordLens Server'
$taskPath = '\'
$projectRoot = Split-Path -Parent $PSScriptRoot
$expectedNodePath = 'C:\Program Files\nodejs\node.exe'
$expectedEnvPath = Join-Path $projectRoot '.env.server'
$expectedIndexPath = Join-Path $projectRoot 'server\index.mjs'
$expectedTaskUser = ([Security.Principal.WindowsIdentity]::GetCurrent().Name -split '\\')[-1]
$siteUrl = 'https://seokwon0429.github.io/vocab-snap/'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Show-ManagerMessage {
  param(
    [Parameter(Mandatory)] [string] $Message,
    [string] $Title = 'WordLens 서버 관리자',
    [System.Windows.MessageBoxImage] $Icon = [System.Windows.MessageBoxImage]::Information
  )

  [void][System.Windows.MessageBox]::Show(
    $Message,
    $Title,
    [System.Windows.MessageBoxButton]::OK,
    $Icon
  )
}

trap {
  try {
    Show-ManagerMessage `
      -Message 'WordLens 서버 관리자에서 예상하지 못한 오류가 발생했습니다. 창을 다시 열어도 계속되면 예약 작업 설정을 확인해 주세요.' `
      -Icon Error
  } catch {}
  exit 1
}

if ((-not (Test-IsAdministrator)) -and (-not $SkipElevation) -and [string]::IsNullOrWhiteSpace($RenderPreviewPath)) {
  try {
    $powershellPath = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $PSCommandPath
    Start-Process `
      -FilePath $powershellPath `
      -ArgumentList $arguments `
      -Verb RunAs `
      -WindowStyle Hidden
  } catch {
    Show-ManagerMessage `
      -Message '서버를 켜고 끄려면 관리자 권한이 필요합니다. 다시 실행한 뒤 Windows 권한 요청에서 예를 눌러 주세요.' `
      -Icon Warning
  }
  exit
}

$createdNew = $false
$instanceMutex = [Threading.Mutex]::new($true, 'Local\WordLensServerManager', [ref] $createdNew)
if (-not $createdNew) {
  Show-ManagerMessage -Message 'WordLens 서버 관리자 창이 이미 열려 있습니다.'
  $instanceMutex.Dispose()
  exit
}

function Get-ServerSetting {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [string] $DefaultValue
  )

  if (-not (Test-Path -LiteralPath $expectedEnvPath -PathType Leaf)) {
    return $DefaultValue
  }

  $pattern = '^\s*{0}\s*=(.*)$' -f [Regex]::Escape($Name)
  $resolvedValue = $DefaultValue
  foreach ($line in Get-Content -LiteralPath $expectedEnvPath -Encoding UTF8) {
    if ($line -notmatch $pattern) { continue }

    $value = $Matches[1].Trim()
    if ($value -match '^"(.*)"\s*(?:#.*)?$' -or $value -match "^'(.*)'\s*(?:#.*)?$") {
      $value = $Matches[1]
    } else {
      $value = ($value -replace '\s+#.*$', '').Trim()
    }
    $resolvedValue = $value
  }

  return $resolvedValue
}

# Retain only the three non-secret settings the manager needs. Invite codes,
# session settings, and account data are never parsed, returned, or displayed.
$configuredHost = Get-ServerSetting -Name 'WORDLENS_HOST' -DefaultValue '127.0.0.1'
$healthHost = switch ($configuredHost.Trim().ToLowerInvariant()) {
  '127.0.0.1' { '127.0.0.1' }
  'localhost' { 'localhost' }
  '0.0.0.0' { '127.0.0.1' }
  '::' { '[::1]' }
  '::1' { '[::1]' }
  default { throw 'WORDLENS_HOST must be a local-only bind address.' }
}

$configuredPort = Get-ServerSetting -Name 'WORDLENS_PORT' -DefaultValue '8787'
$serverPort = 0
if (-not [int]::TryParse($configuredPort, [ref] $serverPort) -or $serverPort -lt 1 -or $serverPort -gt 65535) {
  throw 'WORDLENS_PORT must be an integer between 1 and 65535.'
}
$healthUrl = 'http://{0}:{1}/api/health' -f $healthHost, $serverPort

$configuredDatabasePath = Get-ServerSetting -Name 'WORDLENS_DB_PATH' -DefaultValue 'server/data/wordlens.sqlite'
if ([IO.Path]::IsPathRooted($configuredDatabasePath)) {
  $databasePath = [IO.Path]::GetFullPath($configuredDatabasePath)
} else {
  $databasePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $configuredDatabasePath))
}
$dataDirectory = [IO.Path]::GetDirectoryName($databasePath)

$xaml = @'
<Window
  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Title="WordLens 서버 관리자"
  Width="760"
  Height="680"
  MinWidth="720"
  MinHeight="420"
  WindowStartupLocation="CenterScreen"
  Background="#F3F6FA"
  FontFamily="Malgun Gothic, Segoe UI"
  ResizeMode="CanResizeWithGrip">
  <Window.Resources>
    <Style x:Key="PrimaryButton" TargetType="Button">
      <Setter Property="Height" Value="48" />
      <Setter Property="Foreground" Value="White" />
      <Setter Property="FontSize" Value="14" />
      <Setter Property="FontWeight" Value="SemiBold" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="BorderThickness" Value="0" />
      <Setter Property="Margin" Value="0,0,10,0" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border
              x:Name="ButtonBorder"
              Background="{TemplateBinding Background}"
              CornerRadius="9"
              Padding="18,0">
              <ContentPresenter
                HorizontalAlignment="Center"
                VerticalAlignment="Center" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.88" />
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="ButtonBorder" Property="Opacity" Value="0.72" />
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="ButtonBorder" Property="Background" Value="#C8D0DB" />
                <Setter Property="Foreground" Value="#F7F9FB" />
                <Setter Property="Cursor" Value="Arrow" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="SecondaryButton" TargetType="Button" BasedOn="{StaticResource PrimaryButton}">
      <Setter Property="Height" Value="42" />
      <Setter Property="Foreground" Value="#22304A" />
      <Setter Property="Background" Value="#E9EEF5" />
      <Setter Property="FontSize" Value="13" />
    </Style>
  </Window.Resources>

  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="112" />
      <RowDefinition Height="*" />
    </Grid.RowDefinitions>

    <Border Grid.Row="0" Background="#15233C">
      <Grid Margin="28,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto" />
          <ColumnDefinition Width="*" />
          <ColumnDefinition Width="Auto" />
        </Grid.ColumnDefinitions>
        <Border
          Width="54"
          Height="54"
          CornerRadius="16"
          Background="#5B8DEF"
          VerticalAlignment="Center">
          <TextBlock
            Text="W"
            Foreground="White"
            FontFamily="Segoe UI"
            FontSize="25"
            FontWeight="Bold"
            HorizontalAlignment="Center"
            VerticalAlignment="Center" />
        </Border>
        <StackPanel Grid.Column="1" Margin="16,0,0,0" VerticalAlignment="Center">
          <TextBlock
            Text="WordLens 서버 관리자"
            Foreground="White"
            FontSize="23"
            FontWeight="SemiBold" />
          <TextBlock
            Text="내 컴퓨터의 미니 서버를 안전하게 켜고 끕니다."
            Foreground="#BFCBE0"
            FontSize="12.5"
            Margin="0,6,0,0" />
        </StackPanel>
        <Border
          Grid.Column="2"
          Background="#243653"
          CornerRadius="16"
          Padding="12,7"
          VerticalAlignment="Center">
          <TextBlock
            Text="관리자 권한"
            Foreground="#DCE6F7"
            FontSize="11.5"
            FontWeight="SemiBold" />
        </Border>
      </Grid>
    </Border>

    <ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto">
      <StackPanel Margin="26,22,26,24">
        <Border
          Background="White"
          BorderBrush="#E3E8F0"
          BorderThickness="1"
          CornerRadius="14"
          Padding="22,19">
          <Grid>
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="*" />
              <ColumnDefinition Width="Auto" />
            </Grid.ColumnDefinitions>
            <StackPanel>
              <StackPanel Orientation="Horizontal">
                <Ellipse
                  x:Name="StatusDot"
                  Width="13"
                  Height="13"
                  Fill="#9AA6B6"
                  Margin="0,3,10,0" />
                <TextBlock
                  x:Name="StatusTitle"
                  Text="상태 확인 중"
                  Foreground="#1D2A3F"
                  FontSize="21"
                  FontWeight="SemiBold" />
              </StackPanel>
              <TextBlock
                x:Name="StatusDescription"
                Text="예약 작업과 로컬 API를 확인하고 있습니다."
                Foreground="#66738A"
                FontSize="12.5"
                Margin="23,7,0,0" />
            </StackPanel>
            <Button
              x:Name="RefreshButton"
              Grid.Column="1"
              Content="새로고침"
              Style="{StaticResource SecondaryButton}"
              Width="100"
              Margin="16,0,0,0" />
          </Grid>
        </Border>

        <Border
          Background="White"
          BorderBrush="#E3E8F0"
          BorderThickness="1"
          CornerRadius="14"
          Padding="22,17"
          Margin="0,14,0,0">
          <Grid>
            <Grid.ColumnDefinitions>
              <ColumnDefinition Width="150" />
              <ColumnDefinition Width="*" />
            </Grid.ColumnDefinitions>
            <Grid.RowDefinitions>
              <RowDefinition Height="34" />
              <RowDefinition Height="34" />
              <RowDefinition Height="34" />
            </Grid.RowDefinitions>

            <TextBlock Grid.Row="0" Text="예약 작업" Foreground="#7B8799" VerticalAlignment="Center" />
            <TextBlock x:Name="TaskValue" Grid.Row="0" Grid.Column="1" Text="확인 중" Foreground="#26354E" FontWeight="SemiBold" VerticalAlignment="Center" />
            <TextBlock Grid.Row="1" Text="로컬 API" Foreground="#7B8799" VerticalAlignment="Center" />
            <TextBlock x:Name="ApiValue" Grid.Row="1" Grid.Column="1" Text="확인 중" Foreground="#26354E" FontWeight="SemiBold" VerticalAlignment="Center" />
            <TextBlock Grid.Row="2" Text="마지막 확인" Foreground="#7B8799" VerticalAlignment="Center" />
            <TextBlock x:Name="CheckedValue" Grid.Row="2" Grid.Column="1" Text="-" Foreground="#26354E" FontWeight="SemiBold" VerticalAlignment="Center" />
          </Grid>
        </Border>

        <TextBlock
          Text="서버 전원"
          Foreground="#26354E"
          FontSize="14"
          FontWeight="SemiBold"
          Margin="2,20,0,10" />
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="*" />
          </Grid.ColumnDefinitions>
          <Button
            x:Name="StartButton"
            Grid.Column="0"
            Content="서버 켜기"
            Background="#218B63"
            IsEnabled="False"
            Style="{StaticResource PrimaryButton}" />
          <Button
            x:Name="StopButton"
            Grid.Column="1"
            Content="서버 끄기"
            Background="#D85858"
            IsEnabled="False"
            Style="{StaticResource PrimaryButton}" />
          <Button
            x:Name="RestartButton"
            Grid.Column="2"
            Content="재시작"
            Background="#4D72C8"
            IsEnabled="False"
            Style="{StaticResource PrimaryButton}"
            Margin="0" />
        </Grid>

        <Border
          x:Name="NoticePanel"
          Background="#EAF2FF"
          CornerRadius="9"
          Padding="14,10"
          Margin="0,13,0,0">
          <TextBlock
            x:Name="NoticeText"
            Text="상태를 확인하고 있습니다."
            Foreground="#315D9C"
            FontSize="12"
            TextWrapping="Wrap" />
        </Border>

        <Grid Margin="0,14,0,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="*" />
          </Grid.ColumnDefinitions>
          <Button
            x:Name="OpenSiteButton"
            Grid.Column="0"
            Content="WordLens 사이트 열기"
            Style="{StaticResource SecondaryButton}" />
          <Button
            x:Name="OpenDataButton"
            Grid.Column="1"
            Content="서버 데이터 폴더 열기"
            Style="{StaticResource SecondaryButton}"
            Margin="0" />
        </Grid>

        <TextBlock
          Text="이 창을 닫아도 서버는 계속 실행됩니다. 서버를 끄려면 반드시 ‘서버 끄기’를 눌러 주세요."
          Foreground="#7B8799"
          FontSize="11.5"
          TextWrapping="Wrap"
          Margin="2,15,0,0" />
      </StackPanel>
    </ScrollViewer>
  </Grid>
</Window>
'@

$statusQueryScript = @'
param($TaskName, $TaskPath, $HealthUrl, $ProjectRoot, $ExpectedNode, $ExpectedEnv, $ExpectedIndex, $ExpectedUser)

$ErrorActionPreference = 'Stop'
$taskFound = $false
$taskTrusted = $false
$taskState = 'Unknown'
$lastRunTime = $null
$lastTaskResult = $null
$taskError = $false

try {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
  $taskFound = $true
  $taskState = [string] $task.State
  $taskInfo = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
  $lastRunTime = $taskInfo.LastRunTime
  $lastTaskResult = $taskInfo.LastTaskResult

  $actions = @($task.Actions)
  $actionCountMatches = $actions.Count -eq 1
  $action = if ($actionCountMatches) { $actions[0] } else { $null }
  $nodeMatches = $actionCountMatches -and
    [IO.Path]::GetFullPath([string] $action.Execute) -eq [IO.Path]::GetFullPath($ExpectedNode)
  $workingDirectoryMatches = $actionCountMatches -and
    [IO.Path]::GetFullPath([string] $action.WorkingDirectory) -eq [IO.Path]::GetFullPath($ProjectRoot)
  $expectedArguments = '--env-file="{0}" "{1}"' -f $ExpectedEnv, $ExpectedIndex
  $argumentsMatch = $actionCountMatches -and [string] $action.Arguments -ceq $expectedArguments
  $taskPathMatches = [string] $task.TaskPath -ceq $TaskPath
  $principalMatches = [string] $task.Principal.UserId -ceq $ExpectedUser -and
    [string] $task.Principal.RunLevel -eq 'Limited'
  $filesExist = (Test-Path -LiteralPath $ExpectedNode -PathType Leaf) -and
    (Test-Path -LiteralPath $ExpectedEnv -PathType Leaf) -and
    (Test-Path -LiteralPath $ExpectedIndex -PathType Leaf)
  $taskTrusted = $actionCountMatches -and $nodeMatches -and $workingDirectoryMatches -and
    $argumentsMatch -and $taskPathMatches -and $principalMatches -and $filesExist
} catch {
  if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) {
    $taskError = $true
  }
}

$apiHealthy = $false
try {
  $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
  $apiHealthy = $health.ok -eq $true -and $health.service -eq 'wordlens-api'
} catch {
  $apiHealthy = $false
}

[pscustomobject]@{
  TaskFound = $taskFound
  TaskTrusted = $taskTrusted
  TaskState = $taskState
  TaskError = $taskError
  ApiHealthy = $apiHealthy
  LastRunTime = $lastRunTime
  LastTaskResult = $lastTaskResult
  CheckedAt = Get-Date
}
'@

$taskActionScript = @'
param($TaskName, $TaskPath, $Action, $HealthUrl, $ProjectRoot, $ExpectedNode, $ExpectedEnv, $ExpectedIndex, $ExpectedUser)

$ErrorActionPreference = 'Stop'

function Test-Health {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
    return $health.ok -eq $true -and $health.service -eq 'wordlens-api'
  } catch {
    return $false
  }
}

function Get-TrustedTask {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop

  try {
    $actions = @($task.Actions)
    $actionCountMatches = $actions.Count -eq 1
    $taskAction = if ($actionCountMatches) { $actions[0] } else { $null }
    $nodeMatches = $actionCountMatches -and
      [IO.Path]::GetFullPath([string] $taskAction.Execute) -eq [IO.Path]::GetFullPath($ExpectedNode)
    $workingDirectoryMatches = $actionCountMatches -and
      [IO.Path]::GetFullPath([string] $taskAction.WorkingDirectory) -eq [IO.Path]::GetFullPath($ProjectRoot)
    $expectedArguments = '--env-file="{0}" "{1}"' -f $ExpectedEnv, $ExpectedIndex
    $argumentsMatch = $actionCountMatches -and [string] $taskAction.Arguments -ceq $expectedArguments
    $taskPathMatches = [string] $task.TaskPath -ceq $TaskPath
    $principalMatches = [string] $task.Principal.UserId -ceq $ExpectedUser -and
      [string] $task.Principal.RunLevel -eq 'Limited'
    $filesExist = (Test-Path -LiteralPath $ExpectedNode -PathType Leaf) -and
      (Test-Path -LiteralPath $ExpectedEnv -PathType Leaf) -and
      (Test-Path -LiteralPath $ExpectedIndex -PathType Leaf)
    $trusted = $actionCountMatches -and $nodeMatches -and $workingDirectoryMatches -and
      $argumentsMatch -and $taskPathMatches -and $principalMatches -and $filesExist
  } catch {
    $trusted = $false
  }

  if (-not $trusted) { throw 'TASK_CONFIGURATION_MISMATCH' }
  return $task
}

$task = Get-TrustedTask
$taskState = [string] $task.State

switch ($Action) {
  'Start' {
    if ($taskState -ne 'Ready') { throw 'TASK_STATE_NOT_READY' }
    if (Test-Health) { throw 'UNEXPECTED_SERVER_PROCESS' }
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
  }
  'Stop' {
    if ($taskState -ne 'Running') { throw 'TASK_STATE_NOT_RUNNING' }
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
  }
  'Restart' {
    if ($taskState -ne 'Running') { throw 'TASK_STATE_NOT_RUNNING' }
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
      Start-Sleep -Milliseconds 300
      $task = Get-TrustedTask
      $stopped = [string] $task.State -eq 'Ready' -and -not (Test-Health)
    } until ($stopped -or [DateTime]::UtcNow -ge $deadline)

    if (-not $stopped) { throw 'SERVER_DID_NOT_STOP' }
    $task = Get-TrustedTask
    if ([string] $task.State -ne 'Ready') { throw 'TASK_STATE_NOT_READY' }
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
  }
  default {
    throw 'INVALID_ACTION'
  }
}

[pscustomobject]@{ Success = $true; Action = $Action }
'@

$xmlReader = [System.Xml.XmlNodeReader]::new([xml] $xaml)
$window = [Windows.Markup.XamlReader]::Load($xmlReader)
$xmlReader.Close()
$workAreaHeight = [System.Windows.SystemParameters]::WorkArea.Height
$availableWindowHeight = [Math]::Max(320, $workAreaHeight - 24)
$window.MaxHeight = $workAreaHeight
$window.MinHeight = [Math]::Min(500, $availableWindowHeight)
$window.Height = [Math]::Min(680, $availableWindowHeight)

$statusDot = $window.FindName('StatusDot')
$statusTitle = $window.FindName('StatusTitle')
$statusDescription = $window.FindName('StatusDescription')
$taskValue = $window.FindName('TaskValue')
$apiValue = $window.FindName('ApiValue')
$checkedValue = $window.FindName('CheckedValue')
$noticePanel = $window.FindName('NoticePanel')
$noticeText = $window.FindName('NoticeText')
$startButton = $window.FindName('StartButton')
$stopButton = $window.FindName('StopButton')
$restartButton = $window.FindName('RestartButton')
$refreshButton = $window.FindName('RefreshButton')
$openSiteButton = $window.FindName('OpenSiteButton')
$openDataButton = $window.FindName('OpenDataButton')

$green = [Windows.Media.BrushConverter]::new().ConvertFromString('#25A36F')
$red = [Windows.Media.BrushConverter]::new().ConvertFromString('#D85858')
$amber = [Windows.Media.BrushConverter]::new().ConvertFromString('#E8A23D')
$gray = [Windows.Media.BrushConverter]::new().ConvertFromString('#9AA6B6')
$blueNotice = [Windows.Media.BrushConverter]::new().ConvertFromString('#EAF2FF')
$blueText = [Windows.Media.BrushConverter]::new().ConvertFromString('#315D9C')
$greenNotice = [Windows.Media.BrushConverter]::new().ConvertFromString('#E7F6EF')
$greenText = [Windows.Media.BrushConverter]::new().ConvertFromString('#237653')
$redNotice = [Windows.Media.BrushConverter]::new().ConvertFromString('#FCECEC')
$redText = [Windows.Media.BrushConverter]::new().ConvertFromString('#A83E3E')
$amberNotice = [Windows.Media.BrushConverter]::new().ConvertFromString('#FFF4E1')
$amberText = [Windows.Media.BrushConverter]::new().ConvertFromString('#8C5B10')

if (-not [string]::IsNullOrWhiteSpace($RenderPreviewPath)) {
  $statusDot.Fill = $green
  $statusTitle.Text = '서버 정상 실행 중'
  $statusDescription.Text = '로그인과 서버 단어장을 사용할 수 있습니다.'
  $taskValue.Text = '실행 중'
  $apiValue.Text = '정상 응답'
  $checkedValue.Text = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  $startButton.IsEnabled = $false
  $stopButton.IsEnabled = $true
  $restartButton.IsEnabled = $true
  $noticePanel.Background = $greenNotice
  $noticeText.Foreground = $greenText
  $noticeText.Text = '서버가 정상적으로 실행 중입니다.'

  try {
    $previewPath = [IO.Path]::GetFullPath($RenderPreviewPath)
    $previewDirectory = [IO.Path]::GetDirectoryName($previewPath)
    if (-not [string]::IsNullOrWhiteSpace($previewDirectory)) {
      [IO.Directory]::CreateDirectory($previewDirectory) | Out-Null
    }

    $window.ShowActivated = $false
    $window.ShowInTaskbar = $false
    $window.Left = -10000
    $window.Top = -10000
    $window.Show()
    $window.UpdateLayout()

    $width = [Math]::Max(1, [int] [Math]::Ceiling($window.ActualWidth))
    $height = [Math]::Max(1, [int] [Math]::Ceiling($window.ActualHeight))
    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(
      $width,
      $height,
      96,
      96,
      [Windows.Media.PixelFormats]::Pbgra32
    )
    $bitmap.Render($window)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Open($previewPath, [IO.FileMode]::Create)
    try {
      $encoder.Save($stream)
    } finally {
      $stream.Dispose()
    }
    $window.Close()
  } finally {
    try { $instanceMutex.ReleaseMutex() } catch {}
    $instanceMutex.Dispose()
  }
  exit
}

$runspacePool = [RunspaceFactory]::CreateRunspacePool(1, 2)
$runspacePool.ApartmentState = [Threading.ApartmentState]::MTA
$runspacePool.Open()

$script:statusOperation = $null
$script:actionOperation = $null
$script:lastSnapshot = $null
$script:waitingFor = $null
$script:waitDeadline = $null
$script:nextRefreshAt = [DateTime]::MinValue
$script:isClosing = $false
$script:actionTimedOut = $false
$script:statusTimedOut = $false
$script:abandonedOperations = [Collections.Generic.List[object]]::new()
$script:mutexDisposed = $false
$script:showStatusNoticeOnNextSnapshot = $true

function Set-Notice {
  param(
    [Parameter(Mandatory)] [string] $Text,
    [ValidateSet('Info', 'Success', 'Warning', 'Error')] [string] $Kind = 'Info'
  )

  $noticeText.Text = $Text
  switch ($Kind) {
    'Success' {
      $noticePanel.Background = $greenNotice
      $noticeText.Foreground = $greenText
    }
    'Warning' {
      $noticePanel.Background = $amberNotice
      $noticeText.Foreground = $amberText
    }
    'Error' {
      $noticePanel.Background = $redNotice
      $noticeText.Foreground = $redText
    }
    default {
      $noticePanel.Background = $blueNotice
      $noticeText.Foreground = $blueText
    }
  }
}

function New-BackgroundOperation {
  param(
    [Parameter(Mandatory)] [string] $ScriptText,
    [Parameter(Mandatory)] [object[]] $Arguments,
    [Parameter(Mandatory)] [string] $Kind,
    [string] $Action = '',
    [int] $TimeoutSeconds = 10
  )

  $powerShell = [PowerShell]::Create()
  $powerShell.RunspacePool = $runspacePool
  [void] $powerShell.AddScript($ScriptText)
  foreach ($argument in $Arguments) {
    [void] $powerShell.AddArgument($argument)
  }

  [pscustomobject]@{
    PowerShell = $powerShell
    AsyncResult = $powerShell.BeginInvoke()
    Kind = $Kind
    Action = $Action
    StartedAt = [DateTime]::UtcNow
    Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  }
}

function Start-StatusRefresh {
  if ($script:isClosing -or $script:statusTimedOut -or $null -ne $script:statusOperation) { return }
  $script:statusOperation = New-BackgroundOperation `
    -ScriptText $statusQueryScript `
    -Arguments @($taskName, $taskPath, $healthUrl, $projectRoot, $expectedNodePath, $expectedEnvPath, $expectedIndexPath, $expectedTaskUser) `
    -Kind 'Status' `
    -TimeoutSeconds 10
}

function Disable-ActionButtons {
  $startButton.IsEnabled = $false
  $stopButton.IsEnabled = $false
  $restartButton.IsEnabled = $false
}

function Set-ActionButtons {
  param([bool] $TaskFound, [bool] $TaskTrusted, [string] $TaskState, [bool] $ApiHealthy)

  $busy = $null -ne $script:actionOperation -or $null -ne $script:waitingFor -or
    $script:actionTimedOut -or $script:statusTimedOut
  if ($busy -or -not $TaskFound -or -not $TaskTrusted) {
    Disable-ActionButtons
    return
  }

  $running = $TaskState -eq 'Running'
  $startButton.IsEnabled = $TaskState -eq 'Ready' -and -not $ApiHealthy
  $stopButton.IsEnabled = $running
  $restartButton.IsEnabled = $running
}

function Apply-StatusSnapshot {
  param([Parameter(Mandatory)] $Snapshot)

  $script:lastSnapshot = $Snapshot
  $taskState = [string] $Snapshot.TaskState
  $running = $taskState -eq 'Running'
  $healthy = [bool] $Snapshot.ApiHealthy

  if (-not [bool] $Snapshot.TaskFound) {
    $statusDot.Fill = $red
    $statusTitle.Text = '예약 작업을 찾을 수 없음'
    $statusDescription.Text = 'WordLens Server 예약 작업이 없어서 서버를 제어할 수 없습니다.'
    $taskValue.Text = if ([bool] $Snapshot.TaskError) { '확인 권한 또는 작업 오류' } else { '설치되지 않음' }
  } elseif (-not [bool] $Snapshot.TaskTrusted) {
    $statusDot.Fill = $red
    $statusTitle.Text = '예약 작업 설정 불일치'
    $statusDescription.Text = '다른 프로그램을 실수로 제어하지 않도록 전원 버튼을 잠갔습니다.'
    $taskValue.Text = '프로젝트 경로 확인 필요'
  } elseif ($running -and $healthy) {
    $statusDot.Fill = $green
    $statusTitle.Text = '서버 정상 실행 중'
    $statusDescription.Text = '로그인과 서버 단어장을 사용할 수 있습니다.'
    $taskValue.Text = '실행 중'
  } elseif ($running) {
    $statusDot.Fill = $amber
    $statusTitle.Text = '서버 시작 중 또는 응답 없음'
    $statusDescription.Text = '예약 작업은 실행 중이지만 API 준비를 기다리고 있습니다.'
    $taskValue.Text = '실행 중'
  } elseif ($healthy) {
    $statusDot.Fill = $amber
    $statusTitle.Text = '서버 상태 불일치'
    $statusDescription.Text = '예약 작업 밖에서 실행된 서버가 있을 수 있어 전원 버튼을 잠갔습니다.'
    $taskValue.Text = $taskState
  } elseif ($taskState -eq 'Ready') {
    $statusDot.Fill = $gray
    $statusTitle.Text = '서버 꺼짐'
    $statusDescription.Text = '서버가 꺼져 있습니다. 단어 데이터는 그대로 보관됩니다.'
    $taskValue.Text = '대기 중'
  } else {
    $statusDot.Fill = $amber
    $statusTitle.Text = '예약 작업 상태 확인 필요'
    $statusDescription.Text = '작업이 정상 대기 또는 실행 상태가 아니어서 전원 버튼을 잠갔습니다.'
    $taskValue.Text = $taskState
  }

  $apiValue.Text = if ($healthy) { '정상 응답' } else { '응답 없음' }
  $checkedValue.Text = ([DateTime] $Snapshot.CheckedAt).ToString('yyyy-MM-dd HH:mm:ss')
  Set-ActionButtons `
    -TaskFound ([bool] $Snapshot.TaskFound) `
    -TaskTrusted ([bool] $Snapshot.TaskTrusted) `
    -TaskState ([string] $Snapshot.TaskState) `
    -ApiHealthy $healthy

  if ($script:showStatusNoticeOnNextSnapshot -and $null -eq $script:waitingFor) {
    if (-not [bool] $Snapshot.TaskFound -or -not [bool] $Snapshot.TaskTrusted) {
      Set-Notice -Text '예약 작업 설정을 확인해야 서버를 제어할 수 있습니다.' -Kind Error
    } elseif ($running -and $healthy) {
      Set-Notice -Text '서버가 정상적으로 실행 중입니다.' -Kind Success
    } elseif ($taskState -eq 'Ready' -and -not $healthy) {
      Set-Notice -Text '서버가 꺼져 있습니다. 저장된 단어 데이터는 안전하게 보관됩니다.' -Kind Info
    } else {
      Set-Notice -Text '예약 작업과 API 상태가 일치하지 않아 전원 버튼을 잠갔습니다.' -Kind Warning
    }
    $script:showStatusNoticeOnNextSnapshot = $false
  }

  if ($null -ne $script:waitingFor) {
    $completed = ($script:waitingFor -eq 'Online' -and $running -and $healthy) -or
      ($script:waitingFor -eq 'Offline' -and $taskState -eq 'Ready' -and -not $healthy)
    if ($completed) {
      $message = if ($script:waitingFor -eq 'Online') { '서버가 정상적으로 켜졌습니다.' } else { '서버가 안전하게 꺼졌습니다.' }
      $script:waitingFor = $null
      $script:waitDeadline = $null
      $script:showStatusNoticeOnNextSnapshot = $false
      Set-Notice -Text $message -Kind Success
      Set-ActionButtons `
        -TaskFound ([bool] $Snapshot.TaskFound) `
        -TaskTrusted ([bool] $Snapshot.TaskTrusted) `
        -TaskState ([string] $Snapshot.TaskState) `
        -ApiHealthy $healthy
    } elseif ([DateTime]::UtcNow -ge $script:waitDeadline) {
      $script:waitingFor = $null
      $script:waitDeadline = $null
      $script:showStatusNoticeOnNextSnapshot = $false
      Set-Notice -Text '작업은 요청했지만 제한 시간 안에 목표 상태를 확인하지 못했습니다. 잠시 후 새로고침해 주세요.' -Kind Warning
      Set-ActionButtons `
        -TaskFound ([bool] $Snapshot.TaskFound) `
        -TaskTrusted ([bool] $Snapshot.TaskTrusted) `
        -TaskState $taskState `
        -ApiHealthy $healthy
    }
  }
}

function Convert-ActionErrorMessage {
  param([string] $Details)

  if ($Details -match 'TASK_CONFIGURATION_MISMATCH') {
    return '예약 작업의 실행 경로가 현재 WordLens 프로젝트와 달라서 작업을 중단했습니다.'
  }
  if ($Details -match 'UNEXPECTED_SERVER_PROCESS') {
    return '예약 작업 밖에서 실행 중인 서버가 감지되어 안전을 위해 작업을 중단했습니다.'
  }
  if ($Details -match 'SERVER_DID_NOT_STOP') {
    return '기존 서버가 완전히 꺼지지 않아 중복 실행을 막기 위해 재시작을 중단했습니다.'
  }
  if ($Details -match 'TASK_STATE_NOT_READY|TASK_STATE_NOT_RUNNING') {
    return '예약 작업 상태가 방금 바뀌어 요청을 중단했습니다. 새로고침 후 다시 시도해 주세요.'
  }
  if ($Details -match 'cannot find|찾을 수') {
    return 'WordLens Server 예약 작업을 찾을 수 없습니다.'
  }
  return '서버 작업을 완료하지 못했습니다. 새로고침 후 다시 시도해 주세요.'
}

function Start-ServerAction {
  param([ValidateSet('Start', 'Stop', 'Restart')] [string] $Action)

  if ($script:actionTimedOut -or $script:statusTimedOut -or
    $null -ne $script:actionOperation -or $null -ne $script:waitingFor) { return }

  $script:showStatusNoticeOnNextSnapshot = $false
  Disable-ActionButtons
  $refreshButton.IsEnabled = $false

  $notice = switch ($Action) {
    'Start' { '서버를 켜는 중입니다…' }
    'Stop' { '서버를 안전하게 끄는 중입니다…' }
    'Restart' { '서버를 재시작하는 중입니다…' }
  }
  Set-Notice -Text $notice -Kind Info

  $script:actionOperation = New-BackgroundOperation `
    -ScriptText $taskActionScript `
    -Arguments @($taskName, $taskPath, $Action, $healthUrl, $projectRoot, $expectedNodePath, $expectedEnvPath, $expectedIndexPath, $expectedTaskUser) `
    -Kind 'Action' `
    -Action $Action `
    -TimeoutSeconds 25
}

function Complete-BackgroundOperation {
  param([Parameter(Mandatory)] $Operation)

  try {
    $result = @($Operation.PowerShell.EndInvoke($Operation.AsyncResult))
    $errors = @($Operation.PowerShell.Streams.Error)
    if ($errors.Count -gt 0) {
      throw [InvalidOperationException]::new(($errors | ForEach-Object { $_.Exception.Message }) -join ' ')
    }
    return [pscustomobject]@{ Success = $true; Result = $result }
  } catch {
    return [pscustomobject]@{ Success = $false; Error = $_.Exception.Message }
  } finally {
    $Operation.PowerShell.Dispose()
  }
}

function Request-BackgroundStop {
  param([Parameter(Mandatory)] $Operation)

  try {
    [void] $Operation.PowerShell.BeginStop($null, $null)
  } catch {}
}

$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(250)
$timer.add_Tick({
  if ($script:isClosing) { return }
  $now = [DateTime]::UtcNow

  if ($null -ne $script:actionOperation -and $script:actionOperation.AsyncResult.IsCompleted) {
    $operation = $script:actionOperation
    $script:actionOperation = $null
    $completion = Complete-BackgroundOperation -Operation $operation
    $refreshButton.IsEnabled = -not $script:statusTimedOut

    if ($completion.Success) {
      $script:waitingFor = if ($operation.Action -eq 'Stop') { 'Offline' } else { 'Online' }
      $script:waitDeadline = [DateTime]::UtcNow.AddSeconds(15)
    } else {
      $script:waitingFor = $null
      $script:showStatusNoticeOnNextSnapshot = $false
      Disable-ActionButtons
      Set-Notice -Text (Convert-ActionErrorMessage -Details $completion.Error) -Kind Error
    }
    $script:nextRefreshAt = [DateTime]::MinValue
  } elseif ($null -ne $script:actionOperation -and $now -ge $script:actionOperation.Deadline) {
    $operation = $script:actionOperation
    $script:actionOperation = $null
    $script:actionTimedOut = $true
    $script:showStatusNoticeOnNextSnapshot = $false
    $script:waitingFor = $null
    $script:waitDeadline = $null
    Request-BackgroundStop -Operation $operation
    [void] $script:abandonedOperations.Add($operation)
    $refreshButton.IsEnabled = $false
    Disable-ActionButtons
    Set-Notice -Text 'Windows 작업 스케줄러가 응답하지 않아 전원 버튼을 잠갔습니다. 관리자 창을 닫았다가 다시 열어 현재 상태를 확인해 주세요.' -Kind Error
    $script:nextRefreshAt = [DateTime]::MinValue
  }

  if ($null -ne $script:statusOperation -and $script:statusOperation.AsyncResult.IsCompleted) {
    $operation = $script:statusOperation
    $script:statusOperation = $null
    $completion = Complete-BackgroundOperation -Operation $operation
    if ($completion.Success -and $completion.Result.Count -gt 0) {
      Apply-StatusSnapshot -Snapshot $completion.Result[-1]
    } else {
      $statusDot.Fill = $red
      $statusTitle.Text = '상태 확인 실패'
      $statusDescription.Text = '예약 작업과 로컬 API 상태를 확인하지 못했습니다.'
      $script:showStatusNoticeOnNextSnapshot = $false
      Disable-ActionButtons
      Set-Notice -Text '상태를 확인하지 못했습니다. 관리자 권한과 Windows 작업 스케줄러를 확인해 주세요.' -Kind Error
    }
    $interval = if ($null -ne $script:actionOperation -or $null -ne $script:waitingFor) { 0.5 } else { 2.5 }
    $script:nextRefreshAt = [DateTime]::UtcNow.AddSeconds($interval)
  } elseif ($null -ne $script:statusOperation -and $now -ge $script:statusOperation.Deadline) {
    $operation = $script:statusOperation
    $script:statusOperation = $null
    $script:statusTimedOut = $true
    $script:showStatusNoticeOnNextSnapshot = $false
    Request-BackgroundStop -Operation $operation
    [void] $script:abandonedOperations.Add($operation)
    $statusDot.Fill = $red
    $statusTitle.Text = '상태 확인 시간 초과'
    $statusDescription.Text = 'Windows 작업 스케줄러의 응답이 지연되고 있습니다.'
    $refreshButton.IsEnabled = $false
    Disable-ActionButtons
    Set-Notice -Text '안전을 위해 전원 버튼을 잠갔습니다. 관리자 창을 닫았다가 다시 열어 주세요.' -Kind Error
  }

  if (-not $script:statusTimedOut -and $null -eq $script:statusOperation -and [DateTime]::UtcNow -ge $script:nextRefreshAt) {
    Start-StatusRefresh
  }
})

$refreshButton.add_Click({
  $script:nextRefreshAt = [DateTime]::MinValue
  $script:showStatusNoticeOnNextSnapshot = $true
  Disable-ActionButtons
  Set-Notice -Text '최신 서버 상태를 확인하고 있습니다.' -Kind Info
})

$startButton.add_Click({ Start-ServerAction -Action 'Start' })

$stopButton.add_Click({
  $answer = [System.Windows.MessageBox]::Show(
    $window,
    "서버를 끄면 사이트의 로그인과 서버 단어장을 사용할 수 없습니다.`n저장된 단어 데이터는 삭제되지 않습니다.`n`n정말 서버를 끌까요?",
    'WordLens 서버 끄기',
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Warning,
    [System.Windows.MessageBoxResult]::No
  )
  if ($answer -eq [System.Windows.MessageBoxResult]::Yes) {
    Start-ServerAction -Action 'Stop'
  }
})

$restartButton.add_Click({
  $answer = [System.Windows.MessageBox]::Show(
    $window,
    "재시작하는 동안 연결이 잠깐 끊깁니다.`n지금 서버를 재시작할까요?",
    'WordLens 서버 재시작',
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Question,
    [System.Windows.MessageBoxResult]::No
  )
  if ($answer -eq [System.Windows.MessageBoxResult]::Yes) {
    Start-ServerAction -Action 'Restart'
  }
})

$openSiteButton.add_Click({
  try {
    Start-Process -FilePath $siteUrl
  } catch {
    Show-ManagerMessage -Message '기본 웹 브라우저에서 WordLens 사이트를 열지 못했습니다.' -Icon Warning
  }
})

$openDataButton.add_Click({
  if (-not (Test-Path -LiteralPath $dataDirectory -PathType Container)) {
    Show-ManagerMessage -Message '서버 데이터 폴더를 찾을 수 없습니다.' -Icon Warning
    return
  }
  try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $dataDirectory)
  } catch {
    Show-ManagerMessage -Message '서버 데이터 폴더를 열지 못했습니다.' -Icon Warning
  }
})

$window.add_ContentRendered({
  $timer.Start()
  Start-StatusRefresh
})

$window.add_Closing({
  param($sender, $eventArgs)
  if ($null -ne $script:actionOperation) {
    $answer = [System.Windows.MessageBox]::Show(
      $window,
      "서버 전원 작업이 아직 진행 중입니다.`n창만 닫아도 예약 작업 요청은 완료될 수 있습니다.`n`n그래도 관리자 창을 닫을까요?",
      '작업 중 창 닫기',
      [System.Windows.MessageBoxButton]::YesNo,
      [System.Windows.MessageBoxImage]::Warning,
      [System.Windows.MessageBoxResult]::No
    )
    if ($answer -ne [System.Windows.MessageBoxResult]::Yes) {
      $eventArgs.Cancel = $true
    }
  }
})

$window.add_Closed({
  $script:isClosing = $true
  $timer.Stop()

  $activeOperations = [Collections.Generic.List[object]]::new()
  if ($null -ne $script:statusOperation) {
    [void] $activeOperations.Add($script:statusOperation)
    $script:statusOperation = $null
  }
  if ($null -ne $script:actionOperation) {
    [void] $activeOperations.Add($script:actionOperation)
    $script:actionOperation = $null
  }
  foreach ($operation in $script:abandonedOperations) {
    [void] $activeOperations.Add($operation)
  }

  foreach ($operation in $activeOperations) {
    Request-BackgroundStop -Operation $operation
  }

  if ($activeOperations.Count -eq 0) {
    $runspacePool.Close()
    $runspacePool.Dispose()
  } else {
    # Never let a stuck Task Scheduler RPC keep the manager window/process alive.
    try { $instanceMutex.ReleaseMutex() } catch {}
    $instanceMutex.Dispose()
    $script:mutexDisposed = $true
    [Environment]::Exit(0)
  }
})

try {
  [void] $window.ShowDialog()
} catch {
  Show-ManagerMessage -Message 'WordLens 서버 관리자 창을 실행하지 못했습니다.' -Icon Error
} finally {
  if (-not $script:mutexDisposed) {
    try { $instanceMutex.ReleaseMutex() } catch {}
    $instanceMutex.Dispose()
    $script:mutexDisposed = $true
  }
}
