using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.AccessControl;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LoLAdvisorSetup
{
    internal static class Program
    {
        private const string AppName = "LoL Ranked Advisor";
        private const string AppVersion = "2.1.0";
        private const string NodeZipUrl = "https://nodejs.org/dist/v22.15.0/node-v22.15.0-win-x64.zip";
        private const string ResourceName = "LoLAdvisorPayload.zip";
        private const string UninstallRegPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LoLRankedAdvisor";

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string defaultDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                AppName
            );

            bool silent = false;
            bool cleanMode = false;
            bool noRegistry = false;
            string argDir = "";
            bool desktopShortcut = true;
            bool startMenuShortcut = true;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--silent") silent = true;
                else if (args[i] == "--clean") cleanMode = true;
                else if (args[i] == "--no-registry") noRegistry = true;
                else if (args[i] == "--dir" && i + 1 < args.Length) argDir = args[++i];
                else if (args[i] == "--no-shortcuts")
                {
                    desktopShortcut = false;
                    startMenuShortcut = false;
                }
            }

            if (silent)
            {
                string target = string.IsNullOrEmpty(argDir) ? defaultDir : argDir;
                try
                {
                    RunInstallSync(target, desktopShortcut, startMenuShortcut, cleanMode, !noRegistry, null);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("INSTALL ERROR: " + ex.Message);
                    Environment.ExitCode = 1;
                }
                return;
            }

            string regDir = GetRegisteredInstallDir();
            string initialDir = !string.IsNullOrEmpty(argDir)
                ? argDir
                : (!string.IsNullOrEmpty(regDir) && Directory.Exists(regDir) ? regDir : defaultDir);

            Application.Run(new SetupForm(initialDir, cleanMode));
        }

        internal static string GetRegisteredInstallDir()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallRegPath))
                {
                    if (key != null)
                    {
                        object val = key.GetValue("InstallLocation");
                        if (val != null) return val.ToString().Trim();
                    }
                }
            }
            catch { }
            return "";
        }

        internal static bool HasExistingInstallInDir(string dir)
        {
            if (string.IsNullOrWhiteSpace(dir)) return false;
            try
            {
                string full = Path.GetFullPath(dir.Trim());
                return File.Exists(Path.Combine(full, "LoL Advisor.exe")) ||
                       File.Exists(Path.Combine(full, "server.js")) ||
                       File.Exists(Path.Combine(full, "data", "config.json"));
            }
            catch
            {
                return false;
            }
        }

        internal static string DetectExistingInstall(string candidateDir)
        {
            if (HasExistingInstallInDir(candidateDir))
            {
                return Path.GetFullPath(candidateDir.Trim());
            }
            string regDir = GetRegisteredInstallDir();
            if (HasExistingInstallInDir(regDir))
            {
                return Path.GetFullPath(regDir.Trim());
            }
            return "";
        }

        internal static bool CanWriteToDirectory(string targetDir)
        {
            try
            {
                Directory.CreateDirectory(targetDir);
                string probe = Path.Combine(targetDir, ".setup_write_probe_" + Process.GetCurrentProcess().Id);
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return true;
            }
            catch
            {
                return false;
            }
        }

        internal static void StopExistingAppInstances(string targetDir)
        {
            string normDir = targetDir.TrimEnd('\\').ToLowerInvariant();
            string[] names = { "LoL Advisor", "LoL Overlay", "node" };
            foreach (string procName in names)
            {
                try
                {
                    foreach (Process p in Process.GetProcessesByName(procName))
                    {
                        try
                        {
                            string exePath = p.MainModule != null ? p.MainModule.FileName : "";
                            if (!string.IsNullOrEmpty(exePath) && exePath.ToLowerInvariant().StartsWith(normDir))
                            {
                                p.Kill();
                                p.WaitForExit(1500);
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }
        }

        internal static void CreateShortcut(string shortcutPath, string targetExe, string workingDir, string iconPath, string description)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object sc = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                if (sc == null) return;
                Type scType = sc.GetType();
                scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { targetExe });
                scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workingDir });
                scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { iconPath });
                scType.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { description });
                scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
            }
            finally
            {
                try { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); } catch { }
            }
        }

        internal static void RemoveShortcuts()
        {
            try
            {
                string desktopLink = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    AppName + ".lnk"
                );
                if (File.Exists(desktopLink)) File.Delete(desktopLink);

                string startFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                    "Programs",
                    AppName
                );
                if (Directory.Exists(startFolder)) Directory.Delete(startFolder, true);
            }
            catch { }
        }

        internal static void CleanDirectorySafe(string dir)
        {
            if (string.IsNullOrWhiteSpace(dir)) return;
            string fullDir;
            try { fullDir = Path.GetFullPath(dir.Trim()); }
            catch { return; }
            if (!Directory.Exists(fullDir)) return;

            StopExistingAppInstances(fullDir);
            Thread.Sleep(250);

            string selfExe = "";
            try { selfExe = Path.GetFullPath(Application.ExecutablePath); } catch { }

            // Avoid deleting the installer executable itself if user ran it inside targetDir
            if (!string.IsNullOrEmpty(selfExe) &&
                selfExe.StartsWith(fullDir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            {
                foreach (string subDir in Directory.GetDirectories(fullDir))
                {
                    try { Directory.Delete(subDir, true); } catch { }
                }
                foreach (string file in Directory.GetFiles(fullDir))
                {
                    if (!string.Equals(Path.GetFullPath(file), selfExe, StringComparison.OrdinalIgnoreCase))
                    {
                        try { File.Delete(file); } catch { }
                    }
                }
                return;
            }

            try
            {
                Directory.Delete(fullDir, true);
            }
            catch
            {
                Thread.Sleep(350);
                try { Directory.Delete(fullDir, true); } catch { }
            }
        }

        internal static void RunUninstallSync(
            string installDir,
            bool removeRegistry,
            Action<int, string> onProgress,
            bool includeSideArtifacts = true)
        {
            if (onProgress != null) onProgress(15, "Cerrando procesos abiertos...");
            string regDir = includeSideArtifacts ? GetRegisteredInstallDir() : "";
            string fallbackDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                AppName
            );

            if (!string.IsNullOrEmpty(installDir))
            {
                if (onProgress != null) onProgress(35, "Eliminando carpeta de instalación...");
                CleanDirectorySafe(installDir);
            }
            if (!string.IsNullOrEmpty(regDir) &&
                !string.Equals(regDir.TrimEnd('\\'), (installDir ?? "").TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
            {
                CleanDirectorySafe(regDir);
            }
            if (includeSideArtifacts && Directory.Exists(fallbackDir))
            {
                string fallbackData = Path.Combine(fallbackDir, "data");
                if (Directory.Exists(fallbackData)) CleanDirectorySafe(fallbackData);
                try
                {
                    if (Directory.GetFileSystemEntries(fallbackDir).Length == 0)
                        Directory.Delete(fallbackDir, true);
                }
                catch { }
            }

            if (includeSideArtifacts)
            {
                if (onProgress != null) onProgress(75, "Eliminando accesos directos...");
                RemoveShortcuts();
            }

            if (removeRegistry)
            {
                try { Registry.CurrentUser.DeleteSubKeyTree(UninstallRegPath, false); } catch { }
            }
            if (onProgress != null) onProgress(100, "Instalación anterior eliminada por completo.");
        }

        internal static bool IsCompatibleNodeExe(string nodePath)
        {
            if (string.IsNullOrWhiteSpace(nodePath) || !File.Exists(nodePath)) return false;
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = "-p \"process.versions.node.split('.')[0]\"",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    string outStr = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(4000);
                    int major = 0;
                    return p.ExitCode == 0 && int.TryParse((outStr ?? "").Trim(), out major) && major >= 18;
                }
            }
            catch
            {
                return false;
            }
        }

        internal static string FindSystemNodeExe()
        {
            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs\\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\nodejs\\node.exe")
            };
            foreach (string c in candidates)
            {
                if (IsCompatibleNodeExe(c)) return c;
            }
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathEnv.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string p = Path.Combine(dir.Trim(), "node.exe");
                    if (IsCompatibleNodeExe(p)) return p;
                }
                catch { }
            }
            return "";
        }

        internal static void DownloadNodeRuntime(string destNodeExe, Action<int, string> onProgress)
        {
            try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)12288 | (SecurityProtocolType)3072; }
            catch { try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; } catch { } }

            string tmpZip = Path.Combine(Path.GetTempPath(), "loladvisor_node_" + Process.GetCurrentProcess().Id + ".zip");
            try
            {
                if (onProgress != null) onProgress(48, "Descargando motor Node.js (solo primera vez)...");
                Exception downloadErr = null;
                var doneEvt = new ManualResetEvent(false);

                using (var wc = new WebClient())
                {
                    wc.Headers.Add("User-Agent", "LoLRankedAdvisorSetup/2.1");
                    wc.DownloadProgressChanged += delegate(object sender, DownloadProgressChangedEventArgs ev)
                    {
                        if (onProgress != null)
                        {
                            double gotMb = ev.BytesReceived / 1048576.0;
                            double totMb = ev.TotalBytesToReceive > 0 ? ev.TotalBytesToReceive / 1048576.0 : 33.5;
                            int pct = 48 + (int)((ev.ProgressPercentage * 40) / 100.0);
                            onProgress(pct, string.Format("Descargando motor Node.js: {0}% ({1:0.0}/{2:0.0} MB)", ev.ProgressPercentage, gotMb, totMb));
                        }
                    };
                    wc.DownloadFileCompleted += delegate(object sender, System.ComponentModel.AsyncCompletedEventArgs ev)
                    {
                        downloadErr = ev.Error;
                        doneEvt.Set();
                    };
                    wc.DownloadFileAsync(new Uri(NodeZipUrl), tmpZip);
                    doneEvt.WaitOne();
                }

                if (downloadErr != null)
                {
                    throw new Exception("No se pudo descargar Node.js (" + downloadErr.Message + "). Verifica tu internet.");
                }

                if (onProgress != null) onProgress(89, "Extrayendo motor Node.js...");
                using (var archive = ZipFile.OpenRead(tmpZip))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        if (string.Equals(entry.Name, "node.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(destNodeExe));
                            entry.ExtractToFile(destNodeExe, true);
                            break;
                        }
                    }
                }
            }
            finally
            {
                try { if (File.Exists(tmpZip)) File.Delete(tmpZip); } catch { }
            }

            if (!IsCompatibleNodeExe(destNodeExe))
            {
                throw new Exception("No se pudo verificar node.exe después de descargarlo.");
            }
        }

        internal static void EnsureNodeRuntime(string targetDir, string stashedNodeExe, Action<int, string> onProgress)
        {
            string destDir = Path.Combine(targetDir, "nodejs");
            Directory.CreateDirectory(destDir);
            string destNode = Path.Combine(destDir, "node.exe");

            if (IsCompatibleNodeExe(destNode))
            {
                if (onProgress != null) onProgress(92, "Motor Node.js listo.");
                return;
            }

            if (!string.IsNullOrEmpty(stashedNodeExe) && IsCompatibleNodeExe(stashedNodeExe))
            {
                if (onProgress != null) onProgress(85, "Reutilizando motor Node.js existente...");
                File.Copy(stashedNodeExe, destNode, true);
                try { File.Delete(stashedNodeExe); } catch { }
                return;
            }

            string systemNode = FindSystemNodeExe();
            if (!string.IsNullOrEmpty(systemNode))
            {
                if (onProgress != null) onProgress(85, "Copiando motor Node.js local...");
                File.Copy(systemNode, destNode, true);
                return;
            }

            DownloadNodeRuntime(destNode, onProgress);
        }

        internal static void RunInstallSync(
            string targetDir,
            bool createDesktopShortcut,
            bool createStartMenu,
            bool cleanReinstall,
            bool writeRegistry,
            Action<int, string> onProgress)
        {
            targetDir = Path.GetFullPath(targetDir.Trim());

            // Preserve existing compatible node.exe across clean reinstall so we don't re-download 33 MB!
            string stashedNode = "";
            try
            {
                string candidateNode = Path.Combine(targetDir, "nodejs", "node.exe");
                if (!File.Exists(candidateNode) && writeRegistry)
                {
                    string prevReg = GetRegisteredInstallDir();
                    if (!string.IsNullOrEmpty(prevReg))
                    {
                        candidateNode = Path.Combine(prevReg, "nodejs", "node.exe");
                    }
                }
                if (cleanReinstall && IsCompatibleNodeExe(candidateNode))
                {
                    string tempStash = Path.Combine(Path.GetTempPath(), "loladvisor_stash_node_" + Process.GetCurrentProcess().Id + ".exe");
                    StopExistingAppInstances(Path.GetDirectoryName(Path.GetDirectoryName(candidateNode)));
                    File.Copy(candidateNode, tempStash, true);
                    stashedNode = tempStash;
                }
            }
            catch { stashedNode = ""; }

            if (cleanReinstall)
            {
                if (onProgress != null) onProgress(8, "Borrando versión y datos anteriores...");
                RunUninstallSync(targetDir, false, null, writeRegistry);
            }
            else
            {
                StopExistingAppInstances(targetDir);
            }
            Directory.CreateDirectory(targetDir);

            // Preserve user's existing config.json ONLY when upgrading (not when cleanReinstall is enabled!)
            string existingConfigPath = Path.Combine(targetDir, "data", "config.json");
            string preservedConfig = (!cleanReinstall && File.Exists(existingConfigPath))
                ? File.ReadAllText(existingConfigPath)
                : null;

            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream resStream = asm.GetManifestResourceStream(ResourceName))
            {
                if (resStream == null)
                {
                    throw new Exception("No se encontró el paquete interno de instalación (" + ResourceName + ").");
                }

                using (var archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                {
                    int total = archive.Entries.Count;
                    int done = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        done++;
                        string relPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        if (string.IsNullOrEmpty(relPath)) continue;

                        string destPath = Path.GetFullPath(Path.Combine(targetDir, relPath));
                        if (!destPath.StartsWith(targetDir, StringComparison.OrdinalIgnoreCase)) continue;

                        if (relPath.EndsWith(Path.DirectorySeparatorChar.ToString()))
                        {
                            Directory.CreateDirectory(destPath);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(destPath));
                            if (preservedConfig != null &&
                                string.Equals(relPath, @"data\config.json", StringComparison.OrdinalIgnoreCase))
                            {
                                // Keep existing user config on upgrade
                            }
                            else
                            {
                                entry.ExtractToFile(destPath, true);
                            }
                        }

                        if (onProgress != null && total > 0)
                        {
                            int pct = 10 + (int)((done * 36L) / total);
                            onProgress(pct, "Instalando: " + entry.Name);
                        }
                    }
                }
            }

            if (preservedConfig != null)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(existingConfigPath));
                File.WriteAllText(existingConfigPath, preservedConfig);
            }

            EnsureNodeRuntime(targetDir, stashedNode, onProgress);

            string mainExe = Path.Combine(targetDir, "LoL Advisor.exe");
            string iconFile = Path.Combine(targetDir, "icon.ico");
            string uninstallExe = Path.Combine(targetDir, "Desinstalar LoL Advisor.exe");

            if (createDesktopShortcut && File.Exists(mainExe))
            {
                if (onProgress != null) onProgress(96, "Creando acceso directo en Escritorio...");
                string desktopLink = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    AppName + ".lnk"
                );
                CreateShortcut(desktopLink, mainExe, targetDir, iconFile, AppName + " - Draft, Overlay y Torneo Blitz");
            }

            if (createStartMenu && File.Exists(mainExe))
            {
                if (onProgress != null) onProgress(98, "Creando acceso en Menú Inicio...");
                string startFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                    "Programs",
                    AppName
                );
                Directory.CreateDirectory(startFolder);
                CreateShortcut(Path.Combine(startFolder, AppName + ".lnk"), mainExe, targetDir, iconFile, AppName);
                if (File.Exists(uninstallExe))
                {
                    CreateShortcut(
                        Path.Combine(startFolder, "Desinstalar " + AppName + ".lnk"),
                        uninstallExe,
                        targetDir,
                        iconFile,
                        "Desinstalar " + AppName
                    );
                }
            }

            // Register in Windows Installed Apps (per-user HKCU)
            if (writeRegistry)
            {
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallRegPath))
                    {
                        if (key != null)
                        {
                            key.SetValue("DisplayName", AppName);
                            key.SetValue("DisplayVersion", AppVersion);
                            key.SetValue("Publisher", "LoL Ranked Advisor");
                            key.SetValue("InstallLocation", targetDir);
                            key.SetValue("DisplayIcon", File.Exists(iconFile) ? iconFile : mainExe);
                            if (File.Exists(uninstallExe))
                            {
                                key.SetValue("UninstallString", "\"" + uninstallExe + "\"");
                            }
                            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                        }
                    }
                }
                catch { }
            }

            if (onProgress != null) onProgress(100, "¡Instalación completada!");
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly TextBox pathBox;
        private readonly Button browseBtn;
        private readonly CheckBox chkDesktop;
        private readonly CheckBox chkStartMenu;
        private readonly CheckBox chkLaunch;
        private readonly CheckBox chkCleanReinstall;
        private readonly ProgressBar progress;
        private readonly Label statusLabel;
        private readonly Button uninstallBtn;
        private readonly Button installBtn;
        private readonly Button cancelBtn;
        private bool isInstalling;
        private bool installFinished;

        public SetupForm(string initialDir, bool forceClean = false)
        {
            Text = "Instalador — LoL Ranked Advisor v2.1";
            ClientSize = new Size(560, 428);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(10, 20, 24);
            ForeColor = Color.FromArgb(240, 230, 210);
            Font = new Font("Segoe UI", 9.5f);

            var headerPanel = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(560, 76),
                BackColor = Color.FromArgb(13, 30, 36)
            };
            Controls.Add(headerPanel);

            var titleLbl = new Label
            {
                Text = "LOL RANKED ADVISOR + TORNEO BLITZ",
                Location = new Point(22, 14),
                Size = new Size(516, 26),
                Font = new Font("Segoe UI", 14f, FontStyle.Bold),
                ForeColor = Color.FromArgb(63, 208, 212)
            };
            headerPanel.Controls.Add(titleLbl);

            var subLbl = new Label
            {
                Text = "Instalador ligero · Parche 16.22, Overlay en vivo, Torneo Blitz y Road To.",
                Location = new Point(22, 44),
                Size = new Size(516, 20),
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(184, 151, 90)
            };
            headerPanel.Controls.Add(subLbl);

            var pathLbl = new Label
            {
                Text = "Carpeta donde deseas instalar el programa:",
                Location = new Point(22, 94),
                Size = new Size(420, 20),
                ForeColor = Color.FromArgb(220, 224, 226)
            };
            Controls.Add(pathLbl);

            pathBox = new TextBox
            {
                Text = initialDir,
                Location = new Point(22, 118),
                Size = new Size(414, 26),
                BackColor = Color.FromArgb(17, 34, 40),
                ForeColor = Color.FromArgb(240, 230, 210),
                BorderStyle = BorderStyle.FixedSingle
            };
            pathBox.TextChanged += delegate { RefreshExistingInstallUi(); };
            Controls.Add(pathBox);

            browseBtn = new Button
            {
                Text = "Examinar...",
                Location = new Point(444, 117),
                Size = new Size(94, 27),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(20, 44, 52),
                ForeColor = Color.FromArgb(240, 230, 210)
            };
            browseBtn.FlatAppearance.BorderColor = Color.FromArgb(184, 151, 90);
            browseBtn.Click += OnBrowseClick;
            Controls.Add(browseBtn);

            var hintLbl = new Label
            {
                Text = "Puedes elegir cualquier disco o carpeta (ej. Escritorio, D:\\Juegos\\LoL Advisor o Program Files).",
                Location = new Point(22, 149),
                Size = new Size(516, 18),
                Font = new Font("Segoe UI", 8.2f),
                ForeColor = Color.FromArgb(135, 160, 168)
            };
            Controls.Add(hintLbl);

            chkDesktop = new CheckBox
            {
                Text = "Crear acceso directo en el Escritorio",
                Location = new Point(24, 180),
                Size = new Size(340, 22),
                Checked = true
            };
            Controls.Add(chkDesktop);

            chkStartMenu = new CheckBox
            {
                Text = "Agregar al Menú Inicio (incluye desinstalador)",
                Location = new Point(24, 206),
                Size = new Size(360, 22),
                Checked = true
            };
            Controls.Add(chkStartMenu);

            chkLaunch = new CheckBox
            {
                Text = "Abrir LoL Ranked Advisor al terminar la instalación",
                Location = new Point(24, 232),
                Size = new Size(380, 22),
                Checked = true
            };
            Controls.Add(chkLaunch);

            chkCleanReinstall = new CheckBox
            {
                Text = "Borrar versión y datos anteriores y volver a instalar limpio",
                Location = new Point(24, 260),
                Size = new Size(510, 22),
                ForeColor = Color.FromArgb(255, 209, 102),
                Checked = forceClean || !string.IsNullOrEmpty(Program.DetectExistingInstall(initialDir))
            };
            chkCleanReinstall.CheckedChanged += delegate { RefreshInstallButtonText(); };
            Controls.Add(chkCleanReinstall);

            progress = new ProgressBar
            {
                Location = new Point(22, 304),
                Size = new Size(516, 22),
                Minimum = 0,
                Maximum = 100
            };
            Controls.Add(progress);

            statusLabel = new Label
            {
                Text = "Listo para instalar.",
                Location = new Point(22, 332),
                Size = new Size(516, 20),
                ForeColor = Color.FromArgb(150, 185, 195)
            };
            Controls.Add(statusLabel);

            uninstallBtn = new Button
            {
                Text = "Borrar anterior",
                Location = new Point(22, 370),
                Size = new Size(134, 34),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                BackColor = Color.FromArgb(52, 22, 28),
                ForeColor = Color.FromArgb(255, 148, 162)
            };
            uninstallBtn.FlatAppearance.BorderColor = Color.FromArgb(232, 81, 127);
            uninstallBtn.Click += OnUninstallClick;
            Controls.Add(uninstallBtn);

            installBtn = new Button
            {
                Text = "Instalar ahora",
                Location = new Point(282, 370),
                Size = new Size(148, 34),
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                BackColor = Color.FromArgb(20, 74, 82),
                ForeColor = Color.FromArgb(92, 247, 255)
            };
            installBtn.FlatAppearance.BorderColor = Color.FromArgb(63, 208, 212);
            installBtn.Click += OnInstallClick;
            Controls.Add(installBtn);

            cancelBtn = new Button
            {
                Text = "Cancelar",
                Location = new Point(438, 370),
                Size = new Size(100, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(22, 34, 38),
                ForeColor = Color.FromArgb(210, 210, 210)
            };
            cancelBtn.FlatAppearance.BorderColor = Color.FromArgb(90, 110, 115);
            cancelBtn.Click += delegate { Close(); };
            Controls.Add(cancelBtn);

            RefreshExistingInstallUi();
        }

        private void RefreshInstallButtonText()
        {
            if (installFinished) return;
            bool hasExisting = !string.IsNullOrEmpty(Program.DetectExistingInstall(pathBox.Text));
            if (chkCleanReinstall.Checked)
            {
                installBtn.Text = hasExisting ? "Borrar y reinstalar" : "Instalar limpio";
            }
            else
            {
                installBtn.Text = hasExisting ? "Actualizar" : "Instalar ahora";
            }
        }

        private void RefreshExistingInstallUi()
        {
            if (isInstalling || installFinished) return;
            string existing = Program.DetectExistingInstall(pathBox.Text);
            bool hasExisting = !string.IsNullOrEmpty(existing);
            uninstallBtn.Visible = hasExisting;
            if (hasExisting)
            {
                statusLabel.Text = "Instalación detectada: " + existing;
                statusLabel.ForeColor = Color.FromArgb(255, 209, 102);
            }
            else
            {
                statusLabel.Text = "Listo para instalar.";
                statusLabel.ForeColor = Color.FromArgb(150, 185, 195);
            }
            RefreshInstallButtonText();
        }

        private void OnUninstallClick(object sender, EventArgs e)
        {
            if (isInstalling) return;
            string existing = Program.DetectExistingInstall(pathBox.Text);
            if (string.IsNullOrEmpty(existing))
            {
                RefreshExistingInstallUi();
                return;
            }

            DialogResult ans = MessageBox.Show(
                this,
                "¿Deseas borrar por completo la instalación anterior?\n\nCarpeta: " + existing + "\nSe eliminarán archivos, caché, datos guardados y accesos directos.",
                "Borrar instalación anterior",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning
            );
            if (ans != DialogResult.Yes) return;

            isInstalling = true;
            uninstallBtn.Enabled = false;
            installBtn.Enabled = false;
            browseBtn.Enabled = false;
            pathBox.Enabled = false;

            Thread worker = new Thread(delegate()
            {
                try
                {
                    Program.RunUninstallSync(existing, true, delegate(int pct, string msg)
                    {
                        BeginInvoke(new Action(delegate()
                        {
                            progress.Value = pct;
                            statusLabel.Text = msg;
                            statusLabel.ForeColor = Color.FromArgb(150, 185, 195);
                        }));
                    });

                    BeginInvoke(new Action(delegate()
                    {
                        isInstalling = false;
                        uninstallBtn.Enabled = true;
                        installBtn.Enabled = true;
                        browseBtn.Enabled = true;
                        pathBox.Enabled = true;
                        progress.Value = 0;
                        RefreshExistingInstallUi();
                        statusLabel.Text = "Instalación anterior borrada. Pulsa Instalar si deseas reinstalar.";
                        statusLabel.ForeColor = Color.FromArgb(94, 255, 163);
                    }));
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(delegate()
                    {
                        isInstalling = false;
                        uninstallBtn.Enabled = true;
                        installBtn.Enabled = true;
                        browseBtn.Enabled = true;
                        pathBox.Enabled = true;
                        MessageBox.Show(this, ex.Message, "Error al borrar", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void OnBrowseClick(object sender, EventArgs e)
        {
            if (isInstalling) return;
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Selecciona la carpeta donde instalar LoL Ranked Advisor";
                dlg.SelectedPath = pathBox.Text;
                if (dlg.ShowDialog(this) == DialogResult.OK && !string.IsNullOrEmpty(dlg.SelectedPath))
                {
                    string chosen = dlg.SelectedPath.TrimEnd('\\');
                    string leaf = Path.GetFileName(chosen);
                    if (!string.Equals(leaf, "LoL Ranked Advisor", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(leaf, "LoL Advisor", StringComparison.OrdinalIgnoreCase))
                    {
                        chosen = Path.Combine(chosen, "LoL Ranked Advisor");
                    }
                    pathBox.Text = chosen;
                }
            }
        }

        private void OnInstallClick(object sender, EventArgs e)
        {
            if (installFinished)
            {
                if (chkLaunch.Checked)
                {
                    string mainExe = Path.Combine(pathBox.Text.Trim(), "LoL Advisor.exe");
                    if (File.Exists(mainExe))
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = mainExe,
                            WorkingDirectory = pathBox.Text.Trim(),
                            UseShellExecute = true
                        });
                    }
                }
                Close();
                return;
            }

            if (isInstalling) return;
            string targetDir = pathBox.Text.Trim();
            if (string.IsNullOrEmpty(targetDir))
            {
                MessageBox.Show(this, "Elige una carpeta de instalación.", "Falta carpeta", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (!Program.CanWriteToDirectory(targetDir))
            {
                DialogResult elev = MessageBox.Show(
                    this,
                    "La carpeta seleccionada requiere permisos de Administrador:\n" + targetDir + "\n\n¿Deseas reiniciar el instalador como Administrador?",
                    "Permisos requeridos",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (elev == DialogResult.Yes)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = Application.ExecutablePath,
                            Arguments = "--dir \"" + targetDir + "\"",
                            Verb = "runas",
                            UseShellExecute = true
                        });
                        Close();
                    }
                    catch { }
                }
                return;
            }

            isInstalling = true;
            uninstallBtn.Enabled = false;
            installBtn.Enabled = false;
            browseBtn.Enabled = false;
            pathBox.Enabled = false;
            chkCleanReinstall.Enabled = false;
            bool mkDesktop = chkDesktop.Checked;
            bool mkStart = chkStartMenu.Checked;
            bool cleanBeforeInstall = chkCleanReinstall.Checked;

            Thread worker = new Thread(delegate()
            {
                try
                {
                    Program.RunInstallSync(targetDir, mkDesktop, mkStart, cleanBeforeInstall, true, delegate(int pct, string msg)
                    {
                        BeginInvoke(new Action(delegate()
                        {
                            progress.Value = pct;
                            statusLabel.Text = msg;
                        }));
                    });

                    BeginInvoke(new Action(delegate()
                    {
                        isInstalling = false;
                        installFinished = true;
                        progress.Value = 100;
                        statusLabel.Text = "¡Listo! Instalado en: " + targetDir;
                        statusLabel.ForeColor = Color.FromArgb(94, 255, 163);
                        installBtn.Text = "Finalizar";
                        installBtn.Enabled = true;
                        cancelBtn.Visible = false;
                        uninstallBtn.Visible = false;
                    }));
                }
                catch (Exception ex)
                {
                    BeginInvoke(new Action(delegate()
                    {
                        isInstalling = false;
                        uninstallBtn.Enabled = true;
                        installBtn.Enabled = true;
                        browseBtn.Enabled = true;
                        pathBox.Enabled = true;
                        chkCleanReinstall.Enabled = true;
                        statusLabel.Text = "Error: " + ex.Message;
                        statusLabel.ForeColor = Color.FromArgb(255, 110, 110);
                        MessageBox.Show(this, ex.Message, "Error en instalación", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }
}
