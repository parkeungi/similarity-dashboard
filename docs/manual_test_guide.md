# Manual Test Guide for Similar Callsign Warning System

본 문서는 `simiar_callsign.html` 화면의 기능 및 디자인을 직접 테스트하기 위한 가이드입니다.

## 1. 데이터 연동 확인 (CSV Loading)
- **대상**: `similar_callsign.csv` 파일의 내용이 화면에 로드되는지 확인합니다.
- **방법**: 브라우저에서 `simiar_callsign.html`를 열었을 때, "Sector Summary" 섹션에 각 섹터별(CCP 코드 기준) 건수가 올바르게 표시되는지 확인하십시오.
- **참고**: 보안 정책상 로컬 파일 읽기가 제한될 경우, 시스템의 샘플 데이터가 가상으로 로드됩니다.

## 2. 디자인 및 레이아웃 (Premium ATC UI)
- **다크 모드**: 화면이 세련된 네이비/다크 다이어리 톤으로 구성되어 있는지 확인합니다.
- **글래스모피즘**: 카드 배경이 반투명하며 블러(Blur) 효과가 적용되어 있는지 확인합니다.
- **가독성**: `Orbitron` 폰트(디지털 느낌)와 `Pretendard` 폰트가 관제 정보 식별에 용이한지 확인합니다.

## 3. 기능성 (Interactivity)
- **섹터 필터링**: 좌측 사이드바의 섹터 배지를 클릭하여 테이블이 해당 섹터의 데이터로 필터링되는지 확인합니다.
- **오류 보고**: 테이블의 행(row)을 클릭하면 `⚠️ SUBMIT ERROR REPORT` 모달창이 뜨는지 확인합니다.
- **보고 내역 저장**: 모달에서 정보를 입력 후 'Confirm'을 누른 뒤, 상단 'REPORT HISTORY' 탭에서 내역이 추가되었는지 확인합니다.

## 4. 실시간성
- 우측 상단의 **CLOCK**과 **NETWORK** 상태 표시가 정상적으로 동작하는지 확인합니다.
