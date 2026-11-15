"""Read-only tests for installer preflight guards; no packages/services are changed."""
import subprocess,unittest
from pathlib import Path
SCRIPT=Path(__file__).with_name('install-domain.sh').resolve()
class PreflightTests(unittest.TestCase):
 def bash(self,body):
  return subprocess.run(['bash','-c','source "$1"\n'+body,'installer-test',str(SCRIPT)],capture_output=True,text=True)
 def test_dns_matches_target(self):
  r=self.bash("getent(){ printf '37.32.24.138 STREAM target\\n37.32.24.138 DGRAM target\\n'; }; check_dns")
  self.assertEqual(r.returncode,0,r.stderr)
 def test_ubuntu_2604_is_supported(self):
  r=self.bash('supported_os ubuntu 26.04')
  self.assertEqual(r.returncode,0,r.stderr)
 def test_unsupported_os_is_rejected(self):
  r=self.bash('supported_os centos 7')
  self.assertNotEqual(r.returncode,0)
 def test_dns_wrong_target_or_cdn_stops(self):
  r=self.bash("getent(){ printf '192.0.2.1 STREAM proxy\\n'; }; check_dns")
  self.assertNotEqual(r.returncode,0);self.assertIn('Cloudflare A record',r.stderr)
 def test_other_http_service_stops(self):
  r=self.bash("ss(){ printf 'State Recv-Q Send-Q Local Peer Process\\nLISTEN 0 100 0.0.0.0:80 *:* users:apache2\\n'; }; check_existing_services")
  self.assertNotEqual(r.returncode,0);self.assertIn('Port 80 is occupied',r.stderr)
 def test_existing_app_port_stops(self):
  r=self.bash("ss(){ printf 'State Recv-Q Send-Q Local Peer Process\\n'; if [[ \"$*\" == *3000* ]]; then printf 'LISTEN 0 100 127.0.0.1:3000 *:* users:node\\n'; fi; }; check_existing_services")
  self.assertNotEqual(r.returncode,0);self.assertIn('Port 3000',r.stderr)
 def test_help_does_not_require_root(self):
  r=subprocess.run(['bash',str(SCRIPT),'--help'],capture_output=True,text=True)
  self.assertEqual(r.returncode,0);self.assertIn('target server console',r.stdout)
 def test_syntax(self):
  r=subprocess.run(['bash','-n',str(SCRIPT)],capture_output=True,text=True)
  self.assertEqual(r.returncode,0,r.stderr)
if __name__=='__main__':unittest.main()
