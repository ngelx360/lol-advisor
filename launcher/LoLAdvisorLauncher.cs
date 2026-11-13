using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace LoLAdvisorLauncher
{
    internal static class Program
    {
        private const string BaseUrl = "http://127.0.0.1:3848";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string serverScript = Path.Combine(appDir, "server.js");

            if (!File.Exists(serverScript))
            {
                MessageBox.Show(
                    "No se encontró server.js en la carpeta del programa:\n" + appDir,
                    "LoL Ranked Advisor",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            Process serverProc = null;
            bool startedByMe = false;

            try
            {
                string expectedBuild = GetExpectedBuild(appDir);
                int aliveState = CheckServerState(expectedBuild); // 0 = not running, 1 = current build, 2 = outdated build
                if (aliveState == 2)
                {
                    StopOutdatedServerOnPort3848();
                    Thread.Sleep(400);
                    aliveState = CheckServerState(expectedBuild);
                }

                if (aliveState == 0)
                {
                    string nodeExe = FindNodeExecutable(appDir);
                    if (string.IsNullOrEmpty(nodeExe))
                    {
                        MessageBox.Show(
                            "Node.js no está instalado. Descárgalo desde https://nodejs.org para ejecutar LoL Ranked Advisor.",
                            "LoL Ranked Advisor",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                        return;
                    }

                    var psi = new ProcessStartInfo
                    {
                        FileName = nodeExe,
                        Arguments = "\"server.js\"",
                        WorkingDirectory = appDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    serverProc = Process.Start(psi);
                    startedByMe = true;

                    bool ready = false;
                    for (int i = 0; i < 40; i++)
                    {
                        if (CheckServerState(expectedBuild) == 1)
                        {
                            ready = true;
                            break;
                        }
                        if (serverProc != null && serverProc.HasExited)
                        {
                            if (CheckServerState(expectedBuild) == 1 || CheckServerState(null) == 1)
                            {
                                ready = true;
                                break;
                            }
                            break;
                        }
                        Thread.Sleep(200);
                    }

                    if (!ready && CheckServerState(null) == 1)
                    {
                        ready = true;
                    }

                    if (!ready)
                    {
                        MessageBox.Show(
                            "El servidor local tardó demasiado en iniciar en " + BaseUrl + "\n\nSi el problema continúa, cierra cualquier proceso de Node.js en el Administrador de Tareas y vuelve a abrir el programa.",
                            "LoL Ranked Advisor",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                        return;
                    }
                }

                string browserExe = FindAppShellExecutable();
                if (string.IsNullOrEmpty(browserExe))
                {
                    MessageBox.Show(
                        "No se encontró Microsoft Edge WebView/App ni Google Chrome para abrir la ventana nativa.",
                        "LoL Ranked Advisor",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                string profileDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "LoLAdvisorWindow"
                );
                Directory.CreateDirectory(profileDir);

                var appPsi = new ProcessStartInfo
                {
                    FileName = browserExe,
                    Arguments = string.Format(
                        "--app=\"{0}\" --user-data-dir=\"{1}\" --window-size=1320,860 --no-first-run --no-default-browser-check",
                        BaseUrl,
                        profileDir
                    ),
                    WorkingDirectory = appDir,
                    UseShellExecute = false
                };

                using (Process appProc = Process.Start(appPsi))
                {
                    if (appProc != null)
                    {
                        appProc.WaitForExit();
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Error al iniciar LoL Ranked Advisor:\n" + ex.Message,
                    "LoL Ranked Advisor",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            finally
            {
                if (startedByMe)
                {
                    try
                    {
                        var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/shutdown");
                        req.Method = "POST";
                        req.Timeout = 400;
                        using (req.GetResponse()) { }
                    }
                    catch { }
                }
                if (startedByMe && serverProc != null)
                {
                    try
                    {
                        if (!serverProc.HasExited)
                        {
                            serverProc.Kill();
                        }
                    }
                    catch
                    {
                        // Ignore cleanup errors
                    }
                }
            }
        }

        private static string GetExpectedBuild(string appDir)
        {
            try
            {
                string path = Path.Combine(appDir, "version.json");
                if (File.Exists(path))
                {
                    string json = File.ReadAllText(path);
                    var m = Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) return m.Groups[1].Value.Trim();
                }
            }
            catch { }
            return null;
        }

        private static int CheckServerState(string expectedBuild)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/health");
                req.Method = "GET";
                req.Timeout = 1500;
                using (var resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode != HttpStatusCode.OK) return 0;
                    using (var reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        if (!body.Contains("\"ok\":true")) return 0;
                        if (string.IsNullOrEmpty(expectedBuild)) return 1;
                        return body.Contains("\"appBuild\":\"" + expectedBuild + "\"") ? 1 : 2;
                    }
                }
            }
            catch
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/bootstrap");
                    req.Method = "GET";
                    req.Timeout = 2500;
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    {
                        if (resp.StatusCode != HttpStatusCode.OK) return 0;
                        using (var reader = new StreamReader(resp.GetResponseStream()))
                        {
                            string body = reader.ReadToEnd();
                            if (!body.Contains("\"activeSeason\"") && !body.Contains("\"champions\"")) return 0;
                            if (string.IsNullOrEmpty(expectedBuild)) return 1;
                            return body.Contains("\"appBuild\":\"" + expectedBuild + "\"") ? 1 : 2;
                        }
                    }
                }
                catch
                {
                    return 0;
                }
            }
        }

        private static void StopOutdatedServerOnPort3848()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/shutdown");
                req.Method = "POST";
                req.Timeout = 400;
                using (req.GetResponse()) { }
            }
            catch { }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "netstat.exe",
                    Arguments = "-ano -p tcp",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(1500);
                    foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (!line.Contains("127.0.0.1:3848") || !line.Contains("LISTENING")) continue;
                        var m = Regex.Match(line.Trim(), @"(\d+)$");
                        if (!m.Success) continue;
                        int pid;
                        if (!int.TryParse(m.Groups[1].Value, out pid)) continue;
                        try
                        {
                            var target = Process.GetProcessById(pid);
                            if (target.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase))
                            {
                                target.Kill();
                                target.WaitForExit(1000);
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        private static string FindNodeExecutable(string appDir)
        {
            string[] candidates =
            {
                Path.Combine(appDir, "nodejs\\node.exe"),
                Path.Combine(appDir, "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs\\node.exe")
            };

            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }

            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in pathEnv.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string p = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(p)) return p;
                }
                catch { }
            }

            return null;
        }

        private static string FindAppShellExecutable()
        {
            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google\\Chrome\\Application\\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google\\Chrome\\Application\\chrome.exe")
            };

            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }
    }
}
