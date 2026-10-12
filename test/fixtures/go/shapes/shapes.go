package shapes

import "errors"

func work(n int) (int, error) { return n, nil }
func cleanup()                {}
func risky() error            { return errors.New("x") }

func Sequence(a int) int {
	x, _ := work(a)
	y := x + 1
	y, _ = work(y)
	work(1)
	return y
}

func Branching(flag bool) string {
	if flag {
		work(1)
	} else {
		work(2)
	}
	return "done"
}

func InitCondition(a int) error {
	if v, err := work(a); err != nil {
		return err
	} else if v > 1 {
		work(3)
	}
	return nil
}

func IfWithoutElse(flag bool) {
	if flag {
		work(1)
	}
	work(2)
}

func Loops(items []int) int {
	sum := 0
	for _, i := range items {
		v, _ := work(i)
		sum += v
	}
	for i := 0; i < 3; i++ {
		work(i)
	}
	return sum
}

func Switching(kind string) int {
	switch kind {
	case "a":
		work(1)
	case "b":
		work(2)
		fallthrough
	case "c":
		work(3)
	default:
		work(4)
	}
	return 0
}

func TypeSwitch(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case string, []byte:
		work(1)
	}
	return 0
}

func Selecting(ch chan int, done chan struct{}) {
	select {
	case v := <-ch:
		work(v)
	case <-done:
		cleanup()
	}
}

func DeferGoPanic(ch chan int) {
	defer cleanup()
	go work(1)
	if len(ch) > 3 {
		panic("too many")
	}
	_ = append([]int{}, int(3))
}

func Literals() int {
	handler := func() { work(99) }
	_ = handler
	func() { work(98) }()
	return 0
}

type Service struct{ n int }

func (s *Service) Run() int {
	s.n = s.step()
	return s.n
}

func (s Service) step() int { return s.n }

func Empty() {}

func Unicode() int {
	s := "héllo wörld ✓"; v, _ := work(len(s))
	return v
}
