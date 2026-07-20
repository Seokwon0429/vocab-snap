interface SupplementalKoreanDefinition {
  meaning: string
  partOfSpeech: string
}

/**
 * Curated definitions for common words missing from the Korean Wiktionary
 * snapshot. These stay in the app bundle, so lookups never leave the browser.
 */
export const koreanDictionarySupplement: Readonly<
  Record<string, SupplementalKoreanDefinition>
> = {
  combination: {
    meaning: '결합; 조합; 조합된 것',
    partOfSpeech: '명사',
  },
  composition: {
    meaning: '구성; 작문; 작품',
    partOfSpeech: '명사',
  },
  disability: {
    meaning: '장애; 신체적·정신적 장애',
    partOfSpeech: '명사',
  },
  disarray: {
    meaning: '혼란; 어수선한 상태',
    partOfSpeech: '명사',
  },
  disillusioned: {
    meaning: '환멸을 느낀; 환상이 깨진',
    partOfSpeech: '형용사',
  },
  dismount: {
    meaning: '말·자전거 등에서 내리다',
    partOfSpeech: '동사',
  },
  disputable: {
    meaning: '논쟁의 여지가 있는',
    partOfSpeech: '형용사',
  },
  enable: {
    meaning: '가능하게 하다',
    partOfSpeech: '동사',
  },
  encouraging: {
    meaning: '격려하는; 고무적인',
    partOfSpeech: '형용사',
  },
  enhance: {
    meaning: '향상시키다; 강화하다',
    partOfSpeech: '동사',
  },
  exposure: {
    meaning: '노출; 폭로; 사진의 노출',
    partOfSpeech: '명사',
  },
  expressed: {
    meaning: '표현했다; 표현된; 명시된',
    partOfSpeech: '동사·형용사',
  },
  extrovert: {
    meaning: '외향적인 사람',
    partOfSpeech: '명사',
  },
  illogical: {
    meaning: '비논리적인; 논리에 맞지 않는',
    partOfSpeech: '형용사',
  },
}
