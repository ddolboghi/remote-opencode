# 제안서: 실행 라이프사이클 최종화 안정화와 출력 및 상태 경계 재설계

## Executive Summary

현재 저장소에서 가장 시급하고 지배적인 문제는 장기적인 비음성 메모리 리스크가 아니라, 실행이 인터럽트된 뒤에도 terminal 상태로 깔끔하게 최종화되지 못해 스트리밍 및 상태 전이가 "멈춘 것처럼" 보이는 라이프사이클 최종화 결함입니다. 이 문제는 `docs/discord-interrupt-stuck-rca.md`에서 핵심 원인과 수정 전략으로 정리되어 있습니다.

이미 일부 보강은 `executionService`에 들어가 있습니다. 예를 들어 parent signal을 버퍼링했다가 재생하는 로직, child 추적, visible-text 기반의 fallback 최종화, `settleTerminalStreamMessage()`와 `finalizeInterruptedRun()` 같은 최종화 보조 루틴이 존재합니다. 또한 인터럽트 버튼 경로는 `buttonHandler`에서 세션 abort 이후 `interruptActiveRun(threadId)`를 호출해 정리 경로를 갖고 있습니다. 그럼에도 불구하고 terminal-state 최종화는 `executionService` 내부의 여러 보강 경로와 `buttonHandler`의 인터럽트 진입점 사이에서 보상적으로 처리되고 있으며, 출력과 큐, 영속 상태가 서로 결합된 구조 때문에 terminal-state 결정과 스트림 정착이 결정적으로 끝나지 않는 경우가 발생합니다.

따라서 장기 해법의 1순위는 "terminal-state 최종화가 반드시 완료된다"는 계약과 단일 소유권을 만드는 것입니다. 이 제안서는 중앙화된 lifecycle manager와 durable job record(재시작 시 재조정 포함), 큐 진행과 스트리밍 busy 상태의 분리, 그리고 이를 뒷받침하는 출력 처리 의미 체계(전체 버퍼 재파싱 완화) 및 영속성 도메인 분리를 함께 제안합니다. 목표는 인터럽트와 부분 실패 후에도 상태가 일관되게 terminal로 수렴하고, 시스템이 자동으로 복구 가능한 구조를 갖추는 것입니다.

## Current State

현재 구현의 핵심 특징은 다음과 같습니다.

- **출력 처리(whole-buffer)**: `executionService`는 실행 출력 텍스트를 하나의 누적 문자열(accumulatedText)로 계속 쌓고, 이를 기반으로 상태 업데이트 및 최종 렌더링을 수행합니다. `messageFormatter`는 렌더링을 위해 전체 버퍼를 다시 파싱(`parseOpenCodeOutput(buffer)`)하고, `formatOutput(buffer)`, `formatOutputForMobile(buffer)`도 전체 버퍼를 입력으로 받습니다. 즉, 출력 렌더링은 증분 이벤트가 아니라 "현재까지의 전체 문자열"을 반복 처리하는 의미 체계 위에 있습니다.

- **라이프사이클 최종화(부분 하드닝)**: `executionService`에는 parent signal을 버퍼링하고 재생하는 처리(`bufferedParentSignals`, `replayBufferedParentSignals()`), child 추적, 세션 상태 및 에러 처리, visible-text 기반의 fallback 최종화, 스트림 메시지 정착(`settleTerminalStreamMessage()`), 인터럽트된 실행의 최종화(`finalizeInterruptedRun()`) 등 일부 방어 로직이 존재합니다.

- **영속 상태 저장(단일 data.json, 다도메인 혼재)**: `dataStore`는 `~/.remote-opencode/data.json` 하나를 load/save로 통째로 읽고 쓰는 형태이며, 그 안에 projects, bindings, threadSessions, worktreeMappings, passthroughThreads, queues, queueSettings 등 서로 다른 운영 도메인의 상태가 함께 들어갑니다. 이는 "모든 영속 설정이 data.json에 있다"는 의미는 아니지만, 서로 다른 변경 빈도와 책임을 가진 데이터가 하나의 파일과 하나의 쓰기 경로에 묶여 있습니다.

- **큐 진행과 실행 스트리밍 결합**: `queueManager`는 다음 항목 처리에서 `runPrompt()`를 호출하고, busy 판단을 저장된 SSE client 기반(`isBusy()`)으로 수행합니다. 결과적으로 큐 진행은 실행 스트리밍과 동일한 관찰 지점에 묶이며, terminal-state 최종화가 지연되거나 stuck 상태가 되면 큐 또한 함께 정체될 수 있습니다.

- **인터럽트 경로의 정리 호출은 존재**: `buttonHandler`의 `handleInterrupt()`는 세션을 abort한 뒤 `interruptActiveRun(threadId)`를 호출합니다. 즉, 인터럽트에 정리 경로가 없어서 문제가 발생하는 형태는 아닙니다.

요약하면, 현재의 주요 운영 문제는 "장기 메모리 누적" 자체가 아니라 "인터럽트 이후 terminal-state 최종화가 결정적으로 끝나지 않아 스트리밍 및 상태 전이가 stuck 상태로 남는 것"입니다. 또한 큐 진행이 SSE busy 관찰에 결합되어 있기 때문에, 최종화가 멈추면 큐도 함께 정체되는 2차 효과가 발생할 수 있습니다.

## Root Causes

1. **terminal-state 최종화의 단일 소유권 및 결정성 부족(지배적 원인)**
   - 인터럽트 이후의 상태 전환과 스트리밍 정착이 항상 "끝까지" 완료된다는 보장이 약합니다. `executionService`에 여러 보강 루틴이 추가되어 있고 `buttonHandler`에서도 인터럽트 진입 시 정리 호출이 이어지지만, 최종 상태를 어떤 경로가 언제 확정하는지에 대한 단일 계약은 여전히 약합니다.
   - `docs/discord-interrupt-stuck-rca.md`가 지적하듯, 현재의 주된 버그는 terminal-state 최종화 및 인터럽트 스트리밍이 stuck 상태로 남는 문제입니다.

2. **전체 버퍼 중심의 출력 의미 체계(부하 및 취약성 증폭 요인)**
   - 출력이 append-only 이벤트가 아니라 누적 문자열로 취급되며, 렌더링은 전체 버퍼 재파싱을 전제로 합니다.
   - 이 구조는 출력이 커질수록 렌더링 및 포맷팅 비용이 전체 출력 크기에 비례해 증가하며, 최종화 경로에서도 같은 전제(전체 버퍼 처리)가 반복됩니다.

3. **단일 파일에 다도메인 상태를 혼재하는 영속성 모델(재조정과 정리의 어려움)**
   - `dataStore`는 하나의 `data.json`에 queues 및 queueSettings 같은 운영 상태와 threadSessions, worktreeMappings 등 다양한 도메인을 함께 저장하고, 변경 시 통째로 다시 씁니다.
   - 이는 "남아야 하는 durable 정보"와 "지금만 필요한 운영 상태"의 경계를 흐리게 만들어, 재시작 시 재조정과 terminal-state 정리가 어려워지는 구조적 요인이 됩니다.

4. **큐 진행이 runPrompt()/SSE busy 관찰에 결합됨(전파되는 정체)**
   - `queueManager`가 busy 여부를 SSE client에 의존해 판단하는 구조는, 스트리밍 및 최종화가 stuck 되면 큐 진행도 같은 지점에서 함께 멈추는 결합을 만들어냅니다.

5. **보강 로직의 존재 자체가 근본 해결은 아님(증상 완화의 축적)**
   - `executionService`의 buffered signal 재생, child 추적, fallback 최종화, settle/finalize 보조 루틴은 실제 운영 결함을 줄이기 위한 중요한 완충 장치입니다.
   - 다만 이 방식은 "단일 lifecycle 소유권"과 "결정적 terminal-state 수렴"이라는 아키텍처 계약을 대체하지 못합니다. 결과적으로 수정이 누적될수록 책임 경계가 더 복잡해지고, 특정 경로에서는 여전히 stuck 가능성이 남습니다.

## Proposal Goals

- 인터럽트 및 부분 실패 이후에도 실행이 결정적으로 terminal 상태로 수렴하고, 스트리밍 메시지가 정착되도록 한다.
- 라이프사이클 관리를 중앙화해 최종화와 재조정의 소유권을 분명히 한다.
- 큐 진행을 스트리밍 busy 관찰에 과도하게 결합하지 않도록 분리한다.
- 영속 데이터에서 서로 다른 도메인과 변경 빈도를 분리해, 재시작 시 재조정과 정리가 쉬운 구조를 만든다.
- 출력 처리를 전체 버퍼 기반이 아니라 증분 방식으로 전환해, 렌더링 비용과 최종화 경로의 부담을 낮춘다.
- 관측 가능성과 마이그레이션 규율을 개선해, 변경이 운영 안정성으로 연결되는지 검증 가능하게 한다.
- 내부 아키텍처는 바꾸되, 가능한 범위에서 현재 제품 동작은 유지한다.

## Proposed Architecture

이 제안의 중심은 "terminal-state 최종화의 결정성"과 "단일 lifecycle 소유권"입니다. 아래 구성 요소들은 이 목표를 직접 달성하거나(예: lifecycle manager, durable ledger), 최종화 경로를 간결하고 안정적으로 만들기 위해 주변 결합을 줄이는 역할을 합니다(예: output 의미 체계, 영속성 도메인 분리, 큐 결합 완화).

### 1. Incremental Rendering을 갖춘 OutputStore

비음성 실행 출력의 system of record로 `OutputStore`를 도입합니다.

핵심 개념은 다음과 같습니다.

- 출력을 job ID를 키로 하는 append-only 청크 또는 세그먼트로 저장한다.
- 사용자에게 보이는 메시지는 전체 이력을 다시 파싱하는 방식이 아니라, 청크 범위를 기준으로 증분 렌더링한다.
- 포맷된 메시지 뷰는 정본이 아니라 파생 상태로 취급한다.
- live process object, timer, stream handle, collector, message edit handle 같은 ephemeral handle은 메모리에만 둔다. 이들은 절대 영속화해서는 안 된다.

저장소 영향 범위는 다음과 같습니다.

- `src/services/executionService.ts`는 하나의 커지는 문자열을 직접 관리하는 대신, 구조화된 출력 이벤트를 `OutputStore`에 append해야 합니다.
- `src/utils/messageFormatter.ts`는 누적 전체 버퍼를 파싱하는 역할이 아니라, 청크 윈도우나 요약 뷰를 렌더링하는 역할로 바뀌어야 합니다.

### 2. 도메인 분리 영속성

하나의 단일 파일 기반 다도메인 영속 모델을, 다음과 같이 분리된 저장소로 대체합니다.

- **Config Store**: 영속적으로 유지되어야 하는 구성 및 매핑 정보
- **Session Store**: 재시작 이후에도 유지되어야 하는 세션 메타데이터
- **Job Ledger**: 내구성을 갖는 실행 기록과 재조정 상태
- **Ephemeral Runtime Registry**: 메모리 내 핸들, 활성 프로세스 참조

이 분리는 현재 `src/services/dataStore.ts`가 `data.json` 하나에 여러 운영 도메인을 혼재하는 구조를 직접적으로 겨냥합니다. 서로 다른 변경 빈도와 복구 의미를 가진 데이터가 같은 쓰기 경로를 공유하면, 최종화 및 재조정이 어려워지고 불필요한 전체 재기록이 반복되기 쉽습니다.

### 3. Durable Job Ledger Semantics

명시적 상태 전환을 갖는 durable ledger를 작업 단위에 도입합니다.

- queued
- starting
- running
- completed
- failed
- cancelled
- orphaned
- reconciled
- expired

각 job record에는 다음 정보가 포함되어야 합니다.

- 안정적인 job ID
- session reference
- 필요 시 repository 또는 workspace context
- timestamps
- `OutputStore`를 가리키는 output pointer
- terminal status
- retention metadata
- schema version

이렇게 하면 복구와 정리가 결정적으로 이뤄질 수 있고, `src/services/queueManager.ts`와 `src/services/executionService.ts`가 안정적인 공유 계약을 기반으로 동작할 수 있습니다.

### 4. 중앙화된 Lifecycle Manager

다음 책임을 소유하는 단일 lifecycle manager를 만듭니다.

- job 생성
- 상태 전환
- 시작 시점 재조정
- terminal job 정리
- retention 적용
- session linkage 규칙
- shared-session 충돌 처리

이 manager는 현재 `src/services/executionService.ts`를 중심으로 놓인 최종화 보강 경로와 `src/handlers/buttonHandler.ts`의 인터럽트 진입, 그리고 `src/services/sessionManager.ts`, `src/commands/session.ts`, `src/commands/code.ts`, `src/bot.ts`의 상태 연계 지점을 하나의 계약 아래로 묶는 조정 지점이 되어야 합니다. 특히 인터럽트 이후 terminal-state 최종화, 스트리밍 메시지 정착, 재시작 시 재조정을 단일 계약으로 묶어 "끝나는 실행"을 보장해야 합니다.

특히 shared-session edge case는 명시적인 정책이 필요합니다. 여러 명령이나 상호작용이 같은 세션을 참조하는 경우, lifecycle manager는 작업을 직렬화할지, 하나의 세션 아래에서 독립된 ledger로 관리할지, 아니면 명확한 상태 규칙에 따라 차단할지를 결정해야 합니다. 이 동작은 우발적인 명령 흐름에 맡길 것이 아니라 정책으로 정의되어야 합니다.

### 5. Retention 및 Compaction 정책

보존 정책은 처음부터 설계에 포함되어야 합니다.

- 활성 출력 청크만 hot access path에 유지한다.
- retention window가 지난 terminal job 출력은 요약하거나 compaction한다.
- 오래된 ephemeral metadata는 자동으로 만료시킨다.
- orphaned ledger entry를 정리하고 terminal state로 재조정한다.
- 감사 가능성과 복구에 필요한 내구성 이력은 유지하되, hot payload가 무기한 증가하도록 두지 않는다.

빠른 상한 제한은 여전히 보조 안전장치로 존재할 수 있습니다. 다만 그것이 핵심 설계가 되어서는 안 됩니다.

### 6. Observability 및 Health Signal

아키텍처 경계에서 다음과 같은 observability를 추가합니다.

- 상태별 active job 수
- job별 output chunk volume
- render latency
- queue depth
- reconciliation count
- stale metadata count
- persistence rewrite frequency
- retention sweep 결과

이는 새 설계가 실제로 메모리 압박과 오래된 상태 누적을 줄이는지 검증하기 위해 필요합니다.

### 7. Migration 및 Versioning 기반

새로운 모든 영속 레코드는 schema version을 가져야 합니다. 영속성 reader는 버전 인지형 디코딩과 통제된 마이그레이션 단계를 지원해야 합니다. 그래야 다음 저장소 재설계가 또 다른 일괄 재작성으로 번지지 않습니다.

## Phased Plan

### Phase 1: 경계와 계약 정의
- terminal-state 최종화(인터럽트 포함)와 스트리밍 메시지 정착에 대한 계약과 불변식을 먼저 정의한다.
- `OutputStore`, job ledger, runtime registry, lifecycle manager 인터페이스를 정의한다.
- 현재 `data.json`의 필드를 durable과 ephemeral로 분류한다.
- ephemeral handle은 절대 영속화하지 않는다는 규칙을 문서화한다.

### Phase 2: 새로운 영속성 도메인 도입
- 호환성 어댑터 뒤에 분리된 저장소를 세운다.
- 기존 command 및 bot 진입점은 안정적으로 유지하면서, 저장소 접근만 새 구조로 우회시킨다.
- 모든 durable record에 schema version을 추가한다.

### Phase 3: 출력 처리를 증분 의미 체계로 전환
- `src/services/executionService.ts`를 append-only 출력 이벤트를 내보내는 구조로 리팩터링한다.
- `src/utils/messageFormatter.ts`를 저장된 청크를 기반으로 동작하는 incremental renderer로 리팩터링한다.
- 반복적인 전체 버퍼 포맷팅과 파싱을 중단한다.

### Phase 4: Durable Job Ledger와 중앙 라이프사이클 채택
- 큐와 실행 상태 전환을 lifecycle manager 뒤로 이동시킨다.
- `src/services/queueManager.ts`가 얽힌 런타임 동작을 직접 소유하는 대신 durable job state를 소비하도록 바꾼다.
- 중단된 작업에 대해 시작 시점 재조정을 추가하고, 인터럽트 후에도 terminal-state가 결정적으로 확정되도록 최종화 경로를 통합한다.

### Phase 5: 명령 및 상호작용 흐름 연결
- `src/commands/session.ts`, `src/commands/code.ts`, `src/handlers/buttonHandler.ts`, `src/services/sessionManager.ts`, `src/bot.ts`가 직접 상태를 조작하는 대신 lifecycle API를 사용하도록 갱신한다.
- shared-session 동작을 명시적이고 테스트 가능한 형태로 만든다.

### Phase 6: Retention, Compaction, Observability 활성화
- retention window, compaction 규칙, 오래된 레코드 정리 작업을 추가한다.
- 새 모델이 실제 운영 환경에서 유효한지 검증할 수 있도록 metrics와 health reporting을 추가한다.

## Migration and Rollback Considerations

마이그레이션은 먼저 가산적으로 진행하고, 그다음 감산적으로 진행해야 합니다.

- 중간 단계에서는 기존 `data.json`을 계속 읽으면서, 새 도메인 저장소에도 함께 기록한다.
- 가능한 범위에서 기존 영속 상태를 바탕으로 job ledger record와 session metadata를 백필한다.
- 마이그레이션된 레코드에는 schema version을 표시한다.
- 새로운 lifecycle 경로가 충분히 안정적이라고 입증될 때까지 호환 계층을 유지한다.

롤백은 다음 원칙을 통해 가능해야 합니다.

- 전환 중에도 legacy read를 유지한다.
- 초기 단계에서는 파괴적인 단방향 마이그레이션을 피한다.
- 파생된 출력 뷰는 항상 정본인 output chunk로부터 다시 구성 가능해야 한다.

ephemeral handle은 절대 영속화해서는 안 되므로, 롤백 또한 저장소에서 live process object를 복원하는 방식에 의존해서는 안 됩니다. 복구는 언제나 durable state를 다시 세운 뒤, 런타임 상태를 새로 재조정하는 방식이어야 합니다.

## Risks and Tradeoffs

- **설계 복잡도 증가**: 시스템 컴포넌트는 더 명시적으로 늘어나지만, 이 복잡성은 현재 운영 현실을 반영하는 것이며, 결합된 서비스 내부에 숨겨두는 방식보다 낫습니다.
- **마이그레이션 비용**: 영속성 도메인 분리와 버전 관리 도입에는 초기 비용이 듭니다.
- **동작 변화 리스크**: shared-session 처리 과정에서 현재 코드가 암묵적으로 허용하던 모호성이 드러날 수 있습니다.
- **저장소 증가와의 교환관계**: chunked output과 job ledger는 영속 레코드 수를 늘릴 수 있습니다. 다만 hot memory pressure를 낮추고 retention을 관리 가능하게 만드는 편이 더 중요합니다.
- **전환기의 이중 경로 유지 부담**: 마이그레이션 동안 legacy 경로와 새 경로가 함께 존재할 수 있습니다.

## Non-Goals

- 어떤 형태로든 voice-processing 개선을 포함하지 않는다.
- 빠른 출력 상한 조정을 핵심 전략으로 삼지 않는다.
- 새 아키텍처 지원에 필요한 범위를 넘어, 무관한 command 동작이나 사용자 기능을 재작성하지 않는다.
- runtime-only object, process reference, stream handle, 기타 ephemeral handle을 영속화하지 않는다.

## Success Metrics

- 인터럽트 이후에도 실행이 stuck 상태로 남지 않고, 항상 terminal 상태로 전이된다.
- 실행 중 메모리 증가가 전체 누적 출력 크기가 아니라, 현재 활성인 증분 출력량을 따라간다.
- 포맷팅 비용이 전체 누적 버퍼가 아니라 새로 추가된 출력량에 비례한다.
- 특정 도메인의 영속 변경이 더 이상 혼합된 런타임 상태 전체 재기록을 요구하지 않는다.
- 재시작 후 reconciliation이 중단된 job에 대해 일관된 terminal state를 만든다.
- stale metadata와 orphaned record가 탐지 가능해지고, 시간이 지날수록 줄어든다.
- shared-session 동작이 명시적이고, 관측 가능하며, 결정적이다.
- 저장소 schema에 버전이 부여되고, 마이그레이션이 반복 가능하다.

## Recommended Sequence

1. 구현 변경에 앞서 terminal-state 최종화 계약과 lifecycle 소유권을 먼저 정의한다.
2. `OutputStore`, job ledger, runtime registry를 어댑터 뒤에 도입한다.
3. `src/services/executionService.ts`의 실행 출력과 `src/utils/messageFormatter.ts`의 렌더링을 리팩터링한다.
4. `src/services/queueManager.ts`에서 큐와 실행 조정을 durable ledger semantics 중심으로 옮긴다.
5. 현재 `src/services/sessionManager.ts`, `src/commands/session.ts`, `src/commands/code.ts`, `src/handlers/buttonHandler.ts`, `src/bot.ts`에 흩어진 시작 시 정리 및 라이프사이클 처리를 중앙화한다.
6. retention, compaction, observability, schema-driven migration을 기본 운영 모델로 활성화한다.

이 순서는 장기 해법의 초점을 임시 보완이 아니라 아키텍처에 맞춥니다. 근본 원인을 직접 다루면서도, voice-processing 범위를 끌어들이지 않고 앞으로의 확장을 위한 더 안전한 기반을 만듭니다.
