# Por que construímos a camada de evidência em vez de subir o blueprint de RAG da NVIDIA

Material para o pitch e para a arguição. Todos os números abaixo foram medidos por nós em 15/09/2026 com chave real do NVIDIA NIM.

## A resposta curta

O blueprint da NVIDIA é um bom motor de busca sobre documentos. O operador do sistema elétrico não precisa de um chat que responde sobre PDFs: precisa de uma evidência que ele possa levar para uma auditoria. Usamos os modelos da NVIDIA para extrair e para redigir. A camada que transforma isso em evidência citável, datada e reproduzível é nossa, porque é ela que decide se a resposta serve para operar.

## As cinco diferenças que importam

### 1. O nosso não responde sem citação verificável

Um RAG genérico devolve um texto com as fontes que usou. O nosso devolve um documento estruturado em que **cada afirmação carrega um trecho literal**, e esse trecho só é aceito se existir, caractere por caractere, no pedaço de documento que foi indexado. Junto vão a página ou a tabela, a coordenada do bloco na página, a data de publicação e o sha256 do arquivo original.

Se nenhuma afirmação passa nessa verificação, o sistema não responde: ele declara "sem evidência suficiente" e diz por quê. A diferença de comportamento no pior caso é o ponto: um RAG genérico erra produzindo uma frase plausível, o nosso erra se calando.

### 2. O nosso respeita o tempo da operação

Esta é a diferença que um RAG de prateleira não tem como ter, porque não é software, é domínio.

Uma busca comum procura nos documentos como eles estão hoje. A operação precisa dos documentos **como eles estavam na hora da decisão**: a rodada de D-1 às 9h só pode enxergar o que já havia sido publicado até aquele instante. O nosso retrieval aplica o mesmo corte temporal que o modelo de previsão já aplica nos dados (`published_at` menor ou igual ao instante da rodada).

Sem isso, acontece o erro clássico e invisível: explicar o corte de ontem usando um relatório publicado uma semana depois. O sistema pareceria excelente no backtest e falharia no dia real. O blueprint aceita metadados e filtros, mas quem precisa construir e provar essa disciplina é sempre quem conhece o domínio.

### 3. No nosso, a IA não classifica

No blueprint, o modelo de linguagem responde a pergunta. No WattSteer, ele nunca decide a causa. A classificação entre indisponibilidade externa, confiabilidade elétrica e razão energética continua sendo regra mais SHAP. O RAG entra como evidência, com peso declarado, e quando a evidência contradiz a regra publicamos as duas e declaramos a divergência.

Isso não é preciosismo: é o que permite colocar o sistema na frente de um operador sob os Procedimentos de Rede, onde a decisão é de quem opera e precisa de fundamento rastreável.

### 4. O nosso reproduz o passado

Mesmo dia, mesma entrada, mesmo hash de saída. Isso é possível porque o texto do pedaço citado, a safra do documento, o registro da busca (pergunta, filtros, pedaços recuperados, pontuações, modelo e provedor usados) e o alerta ficam **no mesmo banco e no mesmo ponto no tempo**.

Se a evidência morasse num índice separado, reproduzir o dia D exigiria versionar também aquele índice. Um auditor não aceita "o índice mudou desde então".

### 5. O nosso não para quando o fornecedor muda

Descobrimos isso testando, não supondo. Em 25/08/2026 a NVIDIA encerrou o ciclo de vida de três modelos de embedding que estavam no nosso plano, entre eles o `bge-m3`, e os endpoints de reordenação saíram do ar. Um sistema com esses modelos fixos na configuração simplesmente para.

O nosso chama todo modelo através de um gateway próprio que: usa as chaves de todos os integrantes do time como um conjunto, contando as cotas de cada uma; troca de chave e depois de provedor mantendo a mesma requisição; declara "aguardando cota" em vez de quebrar; e guarda o texto de todo pedaço indexado, de modo que trocar de modelo de embedding é um trabalho agendado, não um desastre.

## Antecipando as perguntas da banca

**"Não dava para subir o blueprint e colocar as suas garantias por cima?"**
As garantias são propriedades do modelo de dados, não um invólucro. Corte temporal, mesma transação, mesmo backup, mesmo hash reproduzível: isso se decide em onde o dado mora. E as duas coisas que o blueprint economizaria já estão conosco: a extração é literalmente o modelo da NVIDIA que estamos chamando, e a busca híbrida é consulta em banco.

**"Construir do zero em dez dias não é arriscado?"**
Medimos o outro lado do risco. O blueprint sobe com Elasticsearch, armazenamento de objetos e mais dois serviços, e o ambiente da AWS só fica aberto para teste de 18 a 20 de setembro. Depurar o sistema de terceiros nessa janela custa mais do que escrever a nossa camada, que é um serviço e um esquema dentro de um Postgres que o time já opera.

**"Vocês não estão usando a NVIDIA, então?"**
Estamos, e nas partes em que ela é melhor. O `nemotron-parse` leu uma página do Boletim Diário da Operação do ONS, que é um PDF sem camada de texto, em 2,2 segundos, devolvendo a tabela de balanço de energia com os valores corretos e a posição de cada bloco na página. O modelo que redige o texto do operador é Nemotron. O que não terceirizamos é o critério do que pode virar evidência.

## Uma frase para o slide

"A NVIDIA nos dá os modelos que leem o documento. Nós damos ao operador a evidência que ele pode citar: com trecho literal, com data de publicação anterior à decisão, e reproduzível no dia seguinte."
