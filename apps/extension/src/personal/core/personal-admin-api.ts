import type { PageControl, PersonalAiSettingsView, PersonalHomeData } from "../../shared/types"
import type { SourceFieldCandidate } from "../ai/semantic-matcher"
import type { PersonalLlmLog } from "../storage/schema"
import type { MappingProfile } from "../../transfer/types"

export interface PersonalAdminApi {
  home(): Promise<PersonalHomeData>
  saveProfile(profile: MappingProfile): Promise<PersonalHomeData>
  deleteProfile(profileId: string): Promise<PersonalHomeData>
  exportProfile(profileId: string): Promise<string>
  importProfile(content: string): Promise<PersonalHomeData>
  clearAll(): Promise<void>
  exportData(): Promise<string>
  exportRecoveryData(): Promise<string>
  exportDiagnostics(): Promise<string>
  aiSettings(): Promise<PersonalAiSettingsView>
  llmLogs(): Promise<PersonalLlmLog[]>
  setLocalAiEnabled(enabled: boolean, modelId: string): Promise<PersonalAiSettingsView>
  matchLocalFields(input: {
    target?: string
    controls: PageControl[]
    allTargetControls?: PageControl[]
    candidates: SourceFieldCandidate[]
  }): Promise<Array<{ control_id: string; information_path: string }>>
}
