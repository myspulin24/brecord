// Minutes loopback helper (Windows): lists output devices and records what a
// chosen output device plays (WASAPI loopback) as 16 kHz mono 16-bit PCM on
// stdout. Chromium can only loop back the default device, so this is used
// when the user picks a specific output. Built on first use with the csc.exe
// that ships with .NET Framework 4.x (C# 5 syntax only).
//
//   minutes-loopback list                 -> JSON array of output devices
//   minutes-loopback capture <id|default|communications>
//                                          -> "READY ..." on stderr, PCM on stdout
//                                             until stdin closes
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace MinutesLoopback
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid fmtid;
        public int pid;
    }

    // PROPVARIANT is 16 bytes on x86 and 24 on x64; reserve the larger size.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint size);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    // Low-pass FIR followed by linear interpolation: plenty for speech.
    class Resampler
    {
        readonly double step;
        readonly float[] taps;
        readonly float[] history;
        int historyPos;
        readonly List<float> filtered = new List<float>();
        double position;

        public Resampler(int inRate, int outRate)
        {
            step = (double)inRate / outRate;
            int n = 63;
            taps = new float[n];
            history = new float[n];
            double cutoff = Math.Min(0.45 * outRate, 7200.0) / inRate;
            double sum = 0;
            for (int i = 0; i < n; i++)
            {
                double m = i - (n - 1) / 2.0;
                double sinc = m == 0 ? 2 * cutoff : Math.Sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
                double window = 0.42 - 0.5 * Math.Cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.Cos(4 * Math.PI * i / (n - 1));
                taps[i] = (float)(sinc * window);
                sum += taps[i];
            }
            for (int i = 0; i < n; i++) taps[i] = (float)(taps[i] / sum);
        }

        public byte[] Process(float[] input, int count)
        {
            for (int s = 0; s < count; s++)
            {
                history[historyPos] = input[s];
                historyPos = (historyPos + 1) % history.Length;
                double acc = 0;
                int idx = historyPos;
                for (int k = 0; k < taps.Length; k++)
                {
                    acc += taps[k] * history[idx];
                    idx = (idx + 1) % history.Length;
                }
                filtered.Add((float)acc);
            }
            var output = new List<byte>();
            while (position + 1 < filtered.Count)
            {
                int i0 = (int)position;
                double frac = position - i0;
                double v = filtered[i0] * (1 - frac) + filtered[i0 + 1] * frac;
                short sample = (short)Math.Max(-32768, Math.Min(32767, Math.Round(v * 32767)));
                output.Add((byte)(sample & 0xff));
                output.Add((byte)((sample >> 8) & 0xff));
                position += step;
            }
            int drop = Math.Min((int)position, filtered.Count);
            filtered.RemoveRange(0, drop);
            position -= drop;
            return output.ToArray();
        }
    }

    static class Program
    {
        const uint DEVICE_STATE_ACTIVE = 1;
        const uint CLSCTX_ALL = 23;
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        static readonly Guid SubtypeFloat = new Guid("00000003-0000-0010-8000-00aa00389b71");
        static volatile bool stopRequested;

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant pv);

        [MTAThread]
        static int Main(string[] args)
        {
            try
            {
                if (args.Length > 0 && args[0] == "list") { List(); return 0; }
                if (args.Length > 0 && args[0] == "capture") return Capture(args.Length > 1 ? args[1] : "default");
                Console.Error.WriteLine("usage: minutes-loopback list | capture <id|default|communications>");
                return 2;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("ERROR " + e.Message);
                return 1;
            }
        }

        // Channel order is FL, FR, FC, LFE, ... Speech lives in the front channels;
        // averaging all eight channels of a virtual 7.1 headset would make it far too quiet.
        static float Downmix(float[] frame, int offset, int channels, float gain)
        {
            if (channels == 1) return frame[offset] * gain;
            float v = (frame[offset] + frame[offset + 1]) * 0.5f;
            if (channels >= 3) v += frame[offset + 2] * 0.7071f;
            return Math.Max(-1f, Math.Min(1f, v * gain));
        }

        static void Check(int hr, string what)
        {
            if (hr != 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")");
        }

        static string Json(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        static string DefaultId(IMMDeviceEnumerator en, ERole role)
        {
            IMMDevice dev;
            if (en.GetDefaultAudioEndpoint(EDataFlow.eRender, role, out dev) != 0) return null;
            string id;
            return dev.GetId(out id) == 0 ? id : null;
        }

        static string FriendlyName(IMMDevice dev)
        {
            IPropertyStore store;
            if (dev.OpenPropertyStore(0, out store) != 0) return "";
            var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
            PropVariant pv;
            if (store.GetValue(ref key, out pv) != 0) return "";
            string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.pointerValue) : "";
            PropVariantClear(ref pv);
            return name ?? "";
        }

        static void List()
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            string defaultId = DefaultId(en, ERole.eConsole);
            string commId = DefaultId(en, ERole.eCommunications);
            IMMDeviceCollection devices;
            Check(en.EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATE_ACTIVE, out devices), "EnumAudioEndpoints");
            uint count;
            Check(devices.GetCount(out count), "GetCount");
            var sb = new StringBuilder("[");
            for (uint i = 0; i < count; i++)
            {
                IMMDevice dev;
                if (devices.Item(i, out dev) != 0) continue;
                string id;
                if (dev.GetId(out id) != 0) continue;
                if (sb.Length > 1) sb.Append(',');
                sb.Append("{\"id\":").Append(Json(id))
                  .Append(",\"name\":").Append(Json(FriendlyName(dev)))
                  .Append(",\"default\":").Append(id == defaultId ? "true" : "false")
                  .Append(",\"communications\":").Append(id == commId ? "true" : "false")
                  .Append('}');
            }
            sb.Append(']');
            byte[] bytes = new UTF8Encoding(false).GetBytes(sb.ToString());
            using (var stdout = Console.OpenStandardOutput()) stdout.Write(bytes, 0, bytes.Length);
        }

        static int Capture(string deviceId)
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice dev;
            if (deviceId == "default") Check(en.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out dev), "GetDefaultAudioEndpoint");
            else if (deviceId == "communications") Check(en.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eCommunications, out dev), "GetDefaultAudioEndpoint");
            else Check(en.GetDevice(deviceId, out dev), "GetDevice (is the output device still connected?)");

            Guid iidClient = typeof(IAudioClient).GUID;
            object o;
            Check(dev.Activate(ref iidClient, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
            var client = (IAudioClient)o;
            IntPtr format;
            Check(client.GetMixFormat(out format), "GetMixFormat");
            int tag = (ushort)Marshal.ReadInt16(format, 0);
            int channels = Marshal.ReadInt16(format, 2);
            int rate = Marshal.ReadInt32(format, 4);
            int bits = Marshal.ReadInt16(format, 14);
            bool isFloat = tag == 3;
            if (tag == 0xFFFE)
            {
                byte[] guid = new byte[16];
                Marshal.Copy(IntPtr.Add(format, 24), guid, 0, 16);
                isFloat = new Guid(guid) == SubtypeFloat;
            }
            if (!isFloat && bits != 16 && bits != 32) throw new Exception("Unsupported mix format: " + bits + "-bit PCM");

            Check(client.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 10000000, 0, format, IntPtr.Zero), "Initialize");
            Guid iidCapture = typeof(IAudioCaptureClient).GUID;
            object co;
            Check(client.GetService(ref iidCapture, out co), "GetService");
            var capture = (IAudioCaptureClient)co;
            var resampler = new Resampler(rate, 16000);

            var watcher = new Thread(delegate ()
            {
                try { Console.In.ReadToEnd(); } catch (Exception) { }
                stopRequested = true;
            });
            watcher.IsBackground = true;
            watcher.Start();

            Check(client.Start(), "Start");
            Console.Error.WriteLine("READY " + rate + " " + channels + " " + bits + (isFloat ? " float" : " pcm"));
            Console.Error.Flush();

            float[] mono = new float[0];
            float[] floats = new float[0];
            short[] shorts = new short[0];
            int[] ints = new int[0];
            using (var stdout = Console.OpenStandardOutput())
            {
                while (!stopRequested)
                {
                    Thread.Sleep(10);
                    uint packet;
                    while (true)
                    {
                        Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize (device removed?)");
                        if (packet == 0) break;
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePos, qpcPos;
                        Check(capture.GetBuffer(out data, out frames, out flags, out devicePos, out qpcPos), "GetBuffer");
                        int n = (int)frames;
                        int total = n * channels;
                        if (mono.Length < n) mono = new float[n];
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
                        {
                            Array.Clear(mono, 0, n);
                        }
                        else if (isFloat)
                        {
                            if (floats.Length < total) floats = new float[total];
                            Marshal.Copy(data, floats, 0, total);
                            for (int f = 0; f < n; f++) mono[f] = Downmix(floats, f * channels, channels, 1f);
                        }
                        else if (bits == 16)
                        {
                            if (shorts.Length < total) shorts = new short[total];
                            Marshal.Copy(data, shorts, 0, total);
                            if (floats.Length < total) floats = new float[total];
                            for (int i = 0; i < total; i++) floats[i] = shorts[i] / 32768f;
                            for (int f = 0; f < n; f++) mono[f] = Downmix(floats, f * channels, channels, 1f);
                        }
                        else
                        {
                            if (ints.Length < total) ints = new int[total];
                            Marshal.Copy(data, ints, 0, total);
                            if (floats.Length < total) floats = new float[total];
                            for (int i = 0; i < total; i++) floats[i] = ints[i] / 2147483648f;
                            for (int f = 0; f < n; f++) mono[f] = Downmix(floats, f * channels, channels, 1f);
                        }
                        Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
                        byte[] pcm = resampler.Process(mono, n);
                        if (pcm.Length > 0)
                        {
                            stdout.Write(pcm, 0, pcm.Length);
                            stdout.Flush();
                        }
                    }
                }
            }
            client.Stop();
            return 0;
        }
    }
}
