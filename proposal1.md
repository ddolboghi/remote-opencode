# 제안서: 비음성 메모리 리스크의 장기적 개선 방안

## Executive Summary

이 저장소는 실행 계층, 영속성 계층, 라이프사이클 계층 전반에 걸친 네 가지 설계 선택이 서로 맞물리면서 비음성 메모리 리스크를 안고 있습니다. 실행 출력은 누적된 전체 문자열로 다뤄지고, 그 결과가 반복적으로 재포맷되거나 다시 파싱됩니다. 영속 설정과 고빈도 런타임 상태는 `data.json`에 함께 저장되며, 변경이 발생할 때마다 파일 전체가 다시 기록됩니다. 큐 오케스트레이션은 실행 라이프사이클과 강하게 결합되어 있습니다. 정리와 재조정 로직도 여러 위치에 분산되어 있어 시간이 지날수록 오래된 메타데이터가 쌓일 수 있습니다.

장기 해법은 버퍼 상한을 늘리거나 잘라내기 정책을 더 공격적으로 적용하는 데 있지 않습니다. 필요한 것은 아키텍처 전환입니다. 이 제안서는 incremental rendering을 갖춘 `OutputStore` 도입, 영속성 도메인 분리, durable job ledger 의미 체계 채택, 라이프사이클 소유권의 중앙화, 보존 정책 적용, 그리고 마이그레이션 및 관측 가능성의 기반 마련을 권고합니다. 목표는 런타임 메모리 사용량을 실제 활성 작업량에 비례하도록 만들고, 영속 상태는 의도된 정보만 남기며, 재시작이나 부분 실패 이후에도 복구가 결정적으로 이뤄지게 하는 것입니다.

## Current State

현재 코드 경로 여러 곳에서 같은 문제가 다른 형태로 드러납니다.

- `src/services/executionService.ts`는 실행 출력 수집과 라이프사이클 전환의 중심에 있습니다. 확인된 결론은 출력 처리가 누적 전체 문자열을 중심으로 구성되어 있고, 전체 버퍼 단위의 포맷팅과 파싱이 반복된다는 점입니다.
- `src/utils/messageFormatter.ts`는 계속 커지는 같은 출력 버퍼를 반복해서 포맷하고 파싱하는 데 관여하며, 작업 시간이 길어질수록 메모리 압박과 CPU 소모를 키웁니다.
- `src/services/dataStore.ts`는 영속 설정과 고빈도 런타임 상태를 모두 `data.json`에 저장하고, 변경이 생길 때마다 파일 전체를 다시 씁니다.
- `src/services/queueManager.ts`는 큐 오케스트레이션을 실행 라이프사이클에 직접 결합하고 있어, 큐 상태와 프로세스 상태가 명확히 분리되어 있지 않습니다.
- `src/services/sessionManager.ts`, `src/commands/session.ts`, `src/commands/code.ts`, `src/handlers/buttonHandler.ts`, `src/bot.ts`는 각각 라이프사이클, 세션, 명령, 상호작용 흐름에 관여하며, 모두 가변 런타임 상태와 정리 동작에 의존합니다.

그 결과, 이 시스템에서 메모리 증가, 영속성 쓰기 부담, 오래된 상태 누적은 서로 독립된 문제가 아닙니다. 설계 차원에서 연결된 문제입니다.

## Root Causes

1. **전체 버퍼 중심의 출력 의미 체계**
   - 출력이 append-only 청크나 세그먼트 스트림이 아니라, 하나의 계속 변하는 문자열로 취급됩니다.
   - 포맷팅과 파싱이 누적된 전체 페이로드를 반복해서 대상으로 삼기 때문에, 비용이 증분 변화량이 아니라 전체 출력 크기에 따라 커집니다.

2. **영속성 도메인의 혼재**
   - `src/services/dataStore.ts`는 영속 설정과 고빈도 런타임 상태를 함께 저장합니다.
   - `data.json`의 빈번한 전체 재기록은 상태 저장 비용을 불필요하게 키우고, 재시작 이후에도 남아야 할 정보와 남아서는 안 되는 정보를 흐리게 만듭니다.

3. **실행과 큐의 결합**
   - `src/services/queueManager.ts`와 `src/services/executionService.ts`는 상호 의존성이 너무 큽니다.
   - 큐잉, 실행 상태, 출력 상태, 재조정이 각각 독립된 관심사와 안정적인 계약으로 모델링되어 있지 않습니다.

4. **분산된 라이프사이클 소유권**
   - 라이프사이클 전환과 정리 동작이 명령 핸들러, 세션 경로, 버튼 플로우, 서비스 코드 전반에 흩어져 있습니다.
   - 이 구조는 고아 메타데이터, 불일치한 정리 동작, 재시작 이후 부분 복구의 가능성을 높입니다.

5. **런타임 작업에 대한 취약한 내구성 모델**
   - 시스템에는 pending, running, completed, failed, cancelled, reconciled, expired 상태를 명확히 정의하는 durable job ledger가 없습니다.
   - shared-session 동작은 여러 흐름이 같은 세션 컨텍스트를 가리킬 수 있기 때문에 이 문제를 더 어렵게 만듭니다.

## Proposal Goals

- 출력 처리를 전체 버퍼 기반이 아니라 증분 방식으로 전환한다.
- 영속 설정과 일시적 런타임 상태를 분리한다.
- 명시적인 재조정 의미 체계를 갖는 durable job record를 도입한다.
- 라이프사이클 관리를 중앙화해 소유권을 분명히 한다.
- 보존 및 정리 정책으로 오래된 메타데이터 누적을 방지한다.
- 재시작 안정성, 관측 가능성, 마이그레이션 규율을 개선한다.
- 내부 아키텍처는 바꾸되, 가능한 범위에서 현재 제품 동작은 유지한다.

## Proposed Architecture

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

하나의 혼합된 영속 모델을 다음과 같이 분리된 저장소로 대체합니다.

- **Config Store**: 영속적인 봇 및 저장소 설정
- **Session Store**: 재시작 이후에도 유지되어야 하는 세션 메타데이터
- **Job Ledger**: 내구성을 갖는 실행 기록과 재조정 상태
- **Ephemeral Runtime Registry**: 메모리 내 핸들, 활성 프로세스 참조

이 분리는 현재 `src/services/dataStore.ts`의 문제를 직접적으로 해결합니다. 영속 설정은 고빈도 런타임 상태와 같은 저장 의미 체계를 공유해서는 안 되며, 런타임 변경이 무관한 영속 데이터 전체 재기록을 유발해서도 안 됩니다.

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

이 manager는 현재 `src/services/sessionManager.ts`, `src/commands/session.ts`, `src/commands/code.ts`, `src/handlers/buttonHandler.ts`, `src/bot.ts`에 분산된 조정 지점이 되어야 합니다.

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
- 중단된 작업과 오래된 메타데이터에 대해 시작 시점 재조정을 추가한다.

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

- 실행 중 메모리 증가가 전체 누적 출력 크기가 아니라, 현재 활성인 증분 출력량을 따라간다.
- 포맷팅 비용이 전체 누적 버퍼가 아니라 새로 추가된 출력량에 비례한다.
- durable config 변경이 더 이상 혼합된 런타임 상태 전체 재기록을 요구하지 않는다.
- 재시작 후 reconciliation이 중단된 job에 대해 일관된 terminal state를 만든다.
- stale metadata와 orphaned record가 탐지 가능해지고, 시간이 지날수록 줄어든다.
- shared-session 동작이 명시적이고, 관측 가능하며, 결정적이다.
- 저장소 schema에 버전이 부여되고, 마이그레이션이 반복 가능하다.

## Recommended Sequence

1. 구현 변경에 앞서 영속성 경계와 lifecycle 소유권을 먼저 정의한다.
2. `OutputStore`, job ledger, runtime registry를 어댑터 뒤에 도입한다.
3. `src/services/executionService.ts`의 실행 출력과 `src/utils/messageFormatter.ts`의 렌더링을 리팩터링한다.
4. `src/services/queueManager.ts`에서 큐와 실행 조정을 durable ledger semantics 중심으로 옮긴다.
5. 현재 `src/services/sessionManager.ts`, `src/commands/session.ts`, `src/commands/code.ts`, `src/handlers/buttonHandler.ts`, `src/bot.ts`에 흩어진 시작 시 정리 및 라이프사이클 처리를 중앙화한다.
6. retention, compaction, observability, schema-driven migration을 기본 운영 모델로 활성화한다.

이 순서는 장기 해법의 초점을 임시 보완이 아니라 아키텍처에 맞춥니다. 근본 원인을 직접 다루면서도, voice-processing 범위를 끌어들이지 않고 앞으로의 확장을 위한 더 안전한 기반을 만듭니다.
