export const basePath = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '')
export const hubUrl = path => basePath + path
