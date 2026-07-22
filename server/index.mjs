import { createWordLensServer } from './app.mjs'

const application = createWordLensServer()

try {
  const url = await application.start()
  console.log(`WordLens API가 실행 중입니다: ${url}`)
  console.log(`상태 확인: ${url}/api/health`)
  if (application.config.generatedInviteCode) {
    console.log(`이번 실행에서 사용할 회원가입 초대 코드: ${application.config.inviteCode}`)
  } else if (application.config.registrationMode === 'open') {
    console.warn('주의: 현재 누구나 새 계정을 만들 수 있습니다.')
  } else if (application.config.registrationMode === 'closed') {
    console.log('새 회원가입이 닫혀 있습니다.')
  }
} catch (error) {
  console.error('WordLens API를 시작하지 못했습니다.', error)
  process.exitCode = 1
}

async function shutdown(signal) {
  console.log(`\n${signal} 신호를 받아 서버를 종료합니다.`)
  await application.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
